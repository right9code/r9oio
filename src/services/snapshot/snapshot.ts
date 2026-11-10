/**
 * Snapshot service — shadow git repo per project for fast undo of agent edits.
 *
 * Mirrors opencode's approach:
 *   - Per-gitdir promise lock so parallel ops don't race on index.lock
 *   - Explicit staging (modified + untracked, respecting work-tree gitignore)
 *   - Files >2 MB go to the shadow's info/exclude so the store stays small
 *   - Atomic restore via read-tree + checkout-index (no HEAD movement)
 *   - Structured per-file diff via the `diff` library — no giant text blobs
 *   - Hourly git gc --prune=7.days so old objects don't accumulate
 *
 * The shadow repo never touches the project's real .git.
 */
import envPaths from 'env-paths'
import { existsSync, mkdirSync } from 'fs'
import { mkdir, readFile, stat, writeFile } from 'fs/promises'
import { dirname, join } from 'path'

import { formatPatch, structuredPatch } from 'diff'

import { execFileNoThrow } from '../../utils/execFileNoThrow.js'
import { djb2Hash } from '../../utils/hash.js'
import { logError } from '../../utils/log.js'

const paths = envPaths('claude-cli')

const MAX_SANITIZED_LENGTH = 200
const LARGE_FILE_LIMIT = 2 * 1024 * 1024
const GC_INTERVAL_MS = 60 * 60 * 1000
const GC_INITIAL_DELAY_MS = 60_000
// Hard ceiling per file in a diff, to keep agents and TUIs from receiving
// megabyte patches from an accidentally-tracked huge file.
const PER_FILE_DIFF_BUDGET = 200 * 1024

const GIT_CORE_FLAGS = [
  '-c',
  'core.longpaths=true',
  '-c',
  'core.symlinks=true',
  '-c',
  'core.autocrlf=false',
  '-c',
  'core.quotepath=false',
] as const

export type SnapshotEntry = {
  hash: string
  date: string
  message: string
}

export type SnapshotResult =
  | { ok: true; hash: string; message: string }
  | { ok: false; message: string }

export type FileDiffStatus = 'added' | 'deleted' | 'modified'

export type FileDiff = {
  file: string
  status: FileDiffStatus
  binary: boolean
  additions: number
  deletions: number
  /** Unified diff text. Empty when binary; "(truncated)" line when too large. */
  patch: string
  /** True when the patch was elided because before/after exceeded the budget. */
  truncated?: boolean
}

function sanitizePath(name: string): string {
  const sanitized = name.replace(/[^a-zA-Z0-9]/g, '-')
  if (sanitized.length <= MAX_SANITIZED_LENGTH) return sanitized
  return `${sanitized.slice(0, MAX_SANITIZED_LENGTH)}-${Math.abs(djb2Hash(name)).toString(36)}`
}

function getSnapshotRoot(projectCwd: string): string {
  return join(paths.data, 'snapshots', sanitizePath(projectCwd))
}

function getShadowGitDir(projectCwd: string): string {
  return join(getSnapshotRoot(projectCwd), '.git')
}

async function gitRun(
  shadowGitDir: string,
  projectCwd: string,
  args: string[],
  input?: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return await execFileNoThrow(
    'git',
    [
      '--git-dir',
      shadowGitDir,
      '--work-tree',
      projectCwd,
      ...GIT_CORE_FLAGS,
      ...args,
    ],
    {
      useCwd: false,
      timeout: 120_000,
      preserveOutputOnError: true,
      ...(input != null ? { stdin: 'pipe' as const, input } : {}),
    },
  )
}

// Per-gitdir serialization. Two snapshot ops on the same shadow repo race on
// index.lock; the chain prevents that. The stored tail never rejects, so a
// failing op doesn't poison subsequent ops.
const locks = new Map<string, Promise<unknown>>()

async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve()
  const result = prev.then(fn, fn)
  locks.set(
    key,
    result.then(
      () => undefined,
      () => undefined,
    ),
  )
  return await result
}

const gcInitialized = new Set<string>()

function startGcLoop(shadowGitDir: string, projectCwd: string): void {
  if (gcInitialized.has(shadowGitDir)) return
  gcInitialized.add(shadowGitDir)

  const tick = (): void => {
    void withLock(shadowGitDir, async () => {
      const r = await gitRun(shadowGitDir, projectCwd, [
        'gc',
        '--prune=7.days',
        '--quiet',
      ])
      if (r.code !== 0) {
        logError(`snapshot gc: ${r.stderr.trim()}`)
      }
    }).catch(e =>
      logError(
        `snapshot gc dispatch: ${e instanceof Error ? e.message : String(e)}`,
      ),
    )
  }

  // unref so the timer never keeps the Node process alive on its own.
  const first = setTimeout(tick, GC_INITIAL_DELAY_MS)
  first.unref?.()
  const recurring = setInterval(tick, GC_INTERVAL_MS)
  recurring.unref?.()
}

async function ensureShadowRepo(projectCwd: string): Promise<string | null> {
  const shadowGitDir = getShadowGitDir(projectCwd)
  if (existsSync(shadowGitDir)) {
    startGcLoop(shadowGitDir, projectCwd)
    return shadowGitDir
  }
  try {
    mkdirSync(shadowGitDir, { recursive: true })
  } catch (e) {
    logError(
      `snapshot: mkdir failed: ${e instanceof Error ? e.message : String(e)}`,
    )
    return null
  }
  const init = await gitRun(shadowGitDir, projectCwd, ['init', '--quiet'])
  if (init.code !== 0) {
    logError(`snapshot: git init failed: ${init.stderr}`)
    return null
  }
  const configs: Array<[string, string]> = [
    ['user.email', 'snapshot@tau.local'],
    ['user.name', 'Tau Snapshot'],
    // Disable filesystem monitor in the shadow repo so we never spawn a
    // watchman/fsmonitor daemon for it.
    ['core.fsmonitor', 'false'],
    // Don't keep an untracked cache for the shadow repo — it'd be stale 99%
    // of the time anyway.
    ['core.untrackedCache', 'false'],
  ]
  for (const [k, v] of configs) {
    await gitRun(shadowGitDir, projectCwd, ['config', k, v])
  }
  startGcLoop(shadowGitDir, projectCwd)
  return shadowGitDir
}

/**
 * Append paths to the shadow repo's info/exclude so they won't be staged.
 * Used to block large files from polluting the snapshot store.
 */
async function blockFiles(
  shadowGitDir: string,
  files: readonly string[],
): Promise<void> {
  if (files.length === 0) return
  const excludeFile = join(shadowGitDir, 'info', 'exclude')
  let existing = ''
  try {
    existing = (await readFile(excludeFile, 'utf8')).trimEnd()
  } catch {
    /* file doesn't exist yet — that's fine */
  }
  const set = new Set<string>(
    existing.split('\n').filter(line => line.trim() !== ''),
  )
  for (const file of files) {
    set.add(`/${file.replace(/\\/g, '/')}`)
  }
  const content = [...set].join('\n') + '\n'
  await mkdir(dirname(excludeFile), { recursive: true })
  await writeFile(excludeFile, content, 'utf8')
}

/**
 * Stage all changed-or-new project files into the shadow index, except
 * files >LARGE_FILE_LIMIT which are blocked via info/exclude.
 */
async function stageChanges(
  shadowGitDir: string,
  projectCwd: string,
): Promise<void> {
  const [modifiedRes, untrackedRes] = await Promise.all([
    gitRun(shadowGitDir, projectCwd, ['diff-files', '--name-only', '-z']),
    gitRun(shadowGitDir, projectCwd, [
      'ls-files',
      '--others',
      '--exclude-standard',
      '-z',
    ]),
  ])
  if (modifiedRes.code !== 0 || untrackedRes.code !== 0) {
    logError(
      `snapshot stage: enumeration failed (diff=${modifiedRes.code}, ls=${untrackedRes.code})`,
    )
    return
  }

  const candidates = new Set<string>()
  for (const f of modifiedRes.stdout.split('\0')) if (f) candidates.add(f)
  for (const f of untrackedRes.stdout.split('\0')) if (f) candidates.add(f)
  if (candidates.size === 0) return

  const large: string[] = []
  const small: string[] = []
  await Promise.all(
    [...candidates].map(async file => {
      try {
        const s = await stat(join(projectCwd, file))
        if (!s.isFile()) return
        const size = typeof s.size === 'bigint' ? Number(s.size) : s.size
        if (size > LARGE_FILE_LIMIT) {
          large.push(file)
        } else {
          small.push(file)
        }
      } catch {
        /* file vanished between enumeration and stat — skip */
      }
    }),
  )

  if (large.length > 0) {
    await blockFiles(shadowGitDir, large)
  }

  if (small.length > 0) {
    const stdin = small.join('\0') + '\0'
    const add = await gitRun(
      shadowGitDir,
      projectCwd,
      [
        'add',
        '--all',
        '--sparse',
        '--pathspec-from-file=-',
        '--pathspec-file-nul',
      ],
      stdin,
    )
    if (add.code !== 0) {
      logError(`snapshot stage: git add failed: ${add.stderr.trim()}`)
    }
  }
}

export async function trackSnapshot(
  projectCwd: string,
  label?: string,
): Promise<SnapshotResult> {
  const shadowGitDir = await ensureShadowRepo(projectCwd)
  if (!shadowGitDir) {
    return { ok: false, message: 'failed to initialize shadow snapshot repo' }
  }
  return await withLock(shadowGitDir, async () => {
    await stageChanges(shadowGitDir, projectCwd)
    const msg = label?.trim()
      ? `snapshot: ${label.trim()}`
      : `snapshot: ${new Date().toISOString()}`
    const commit = await gitRun(shadowGitDir, projectCwd, [
      'commit',
      '-m',
      msg,
      '--allow-empty',
      '--quiet',
    ])
    if (commit.code !== 0) {
      return {
        ok: false,
        message: `git commit failed: ${commit.stderr.trim()}`,
      }
    }
    const head = await gitRun(shadowGitDir, projectCwd, ['rev-parse', 'HEAD'])
    if (head.code !== 0) {
      return {
        ok: false,
        message: `git rev-parse failed: ${head.stderr.trim()}`,
      }
    }
    return {
      ok: true,
      hash: head.stdout.trim(),
      message: `snapshot ${head.stdout.trim().slice(0, 8)} created`,
    }
  })
}

/**
 * Restore the project working tree to a snapshot. Uses read-tree +
 * checkout-index so it's atomic and never touches HEAD. Does NOT delete
 * files that are in the work tree but not in the snapshot — that's safer
 * and matches opencode's semantics.
 */
export async function revertSnapshot(
  projectCwd: string,
  hash: string,
): Promise<SnapshotResult> {
  const shadowGitDir = await ensureShadowRepo(projectCwd)
  if (!shadowGitDir) {
    return { ok: false, message: 'failed to initialize shadow snapshot repo' }
  }
  const trimmed = hash.trim()
  if (!/^[0-9a-fA-F]{4,64}$/.test(trimmed)) {
    return { ok: false, message: `invalid snapshot hash: ${hash}` }
  }
  return await withLock(shadowGitDir, async () => {
    const exists = await gitRun(shadowGitDir, projectCwd, [
      'cat-file',
      '-e',
      `${trimmed}^{commit}`,
    ])
    if (exists.code !== 0) {
      return { ok: false, message: `snapshot ${trimmed} not found` }
    }
    const readTree = await gitRun(shadowGitDir, projectCwd, [
      'read-tree',
      trimmed,
    ])
    if (readTree.code !== 0) {
      return {
        ok: false,
        message: `read-tree failed: ${readTree.stderr.trim()}`,
      }
    }
    const checkout = await gitRun(shadowGitDir, projectCwd, [
      'checkout-index',
      '-a',
      '-f',
    ])
    if (checkout.code !== 0) {
      return {
        ok: false,
        message: `checkout-index failed: ${checkout.stderr.trim()}`,
      }
    }
    return {
      ok: true,
      hash: trimmed,
      message: `working tree restored to ${trimmed.slice(0, 8)}`,
    }
  })
}

export async function listSnapshots(
  projectCwd: string,
  limit = 20,
): Promise<SnapshotEntry[]> {
  const shadowGitDir = await ensureShadowRepo(projectCwd)
  if (!shadowGitDir) return []
  const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)))
  const log = await gitRun(shadowGitDir, projectCwd, [
    'log',
    `--max-count=${safeLimit}`,
    '--format=%H%x09%cI%x09%s',
  ])
  if (log.code !== 0) return []
  return log.stdout
    .split('\n')
    .filter(line => line.trim() !== '')
    .map(line => {
      const [hash = '', date = '', ...rest] = line.split('\t')
      return { hash, date, message: rest.join('\t') }
    })
}

// Shared core for snapshotDiff (snapshot → working tree) and
// snapshotDiffBetween (snapshot → snapshot). `diffRefs` is the ref(s) passed to
// `git diff` (one ref = ref-vs-working-tree; two = base-vs-target). `baseRef`
// sources the "before" side via `git show`; `getAfter` sources the "after".
async function buildFileDiffs(
  projectCwd: string,
  shadowGitDir: string,
  diffRefs: string[],
  baseRef: string,
  getAfter: (file: string) => Promise<string>,
): Promise<FileDiff[]> {
  const [statusRes, numstatRes] = await Promise.all([
    gitRun(shadowGitDir, projectCwd, [
      'diff',
      '--name-status',
      '--no-renames',
      '-z',
      ...diffRefs,
      '--',
      '.',
    ]),
    gitRun(shadowGitDir, projectCwd, [
      'diff',
      '--numstat',
      '--no-renames',
      '-z',
      ...diffRefs,
      '--',
      '.',
    ]),
  ])
  if (statusRes.code !== 0 || numstatRes.code !== 0) return []

  // --name-status -z output: status\0file\0status\0file\0...
  const statusMap = new Map<string, FileDiffStatus>()
  const sParts = statusRes.stdout.split('\0').filter(p => p !== '')
  for (let i = 0; i + 1 < sParts.length; i += 2) {
    const code = sParts[i] ?? ''
    const file = sParts[i + 1] ?? ''
    if (!code || !file) continue
    const first = code.charAt(0)
    statusMap.set(
      file,
      first === 'A' ? 'added' : first === 'D' ? 'deleted' : 'modified',
    )
  }

  // --numstat -z output: each entry is "additions\tdeletions\tfile" then \0
  type Row = {
    file: string
    additions: number
    deletions: number
    binary: boolean
  }
  const rows: Row[] = []
  for (const entry of numstatRes.stdout.split('\0')) {
    if (!entry) continue
    const parts = entry.split('\t')
    if (parts.length < 3) continue
    const adds = parts[0] ?? ''
    const dels = parts[1] ?? ''
    const file = parts.slice(2).join('\t')
    if (!file) continue
    const binary = adds === '-' && dels === '-'
    rows.push({
      file,
      binary,
      additions: binary ? 0 : Number.parseInt(adds, 10) || 0,
      deletions: binary ? 0 : Number.parseInt(dels, 10) || 0,
    })
  }

  // Fetch before/after concurrently per file.
  return await Promise.all(
    rows.map(async (row): Promise<FileDiff> => {
      const status = statusMap.get(row.file) ?? 'modified'
      if (row.binary) {
        return {
          file: row.file,
          status,
          binary: true,
          additions: 0,
          deletions: 0,
          patch: '',
        }
      }
      const [before, after] = await Promise.all([
        status === 'added'
          ? Promise.resolve('')
          : gitRun(shadowGitDir, projectCwd, [
              'show',
              `${baseRef}:${row.file}`,
            ]).then(r => (r.code === 0 ? r.stdout : '')),
        status === 'deleted' ? Promise.resolve('') : getAfter(row.file),
      ])
      const total = before.length + after.length
      if (total > PER_FILE_DIFF_BUDGET) {
        return {
          file: row.file,
          status,
          binary: false,
          additions: row.additions,
          deletions: row.deletions,
          patch: `(diff elided: ${total} bytes exceeds per-file budget of ${PER_FILE_DIFF_BUDGET} bytes)`,
          truncated: true,
        }
      }
      let patch = ''
      try {
        patch = formatPatch(
          structuredPatch(row.file, row.file, before, after, '', ''),
        )
      } catch (e) {
        patch = `(diff failed: ${e instanceof Error ? e.message : String(e)})`
      }
      return {
        file: row.file,
        status,
        binary: false,
        additions: row.additions,
        deletions: row.deletions,
        patch,
      }
    }),
  )
}

/**
 * Structured per-file diff between the snapshot and the current working
 * tree. The patch direction is snapshot → working tree, so `+` lines are
 * what restoring the snapshot would REMOVE and `-` lines are what restoring
 * would BRING BACK.
 *
 * Returns one entry per changed file. Binary files have `binary: true` and
 * `patch: ''`. Files exceeding PER_FILE_DIFF_BUDGET get `truncated: true`
 * and a placeholder patch.
 */
export async function snapshotDiff(
  projectCwd: string,
  hash: string,
): Promise<FileDiff[]> {
  const shadowGitDir = await ensureShadowRepo(projectCwd)
  if (!shadowGitDir) return []
  const trimmed = hash.trim()
  if (!/^[0-9a-fA-F]{4,64}$/.test(trimmed)) return []

  return await withLock(shadowGitDir, async () => {
    const resolved = await gitRun(shadowGitDir, projectCwd, [
      'rev-parse',
      '--verify',
      `${trimmed}^{commit}`,
    ])
    if (resolved.code !== 0) return []
    const fullHash = resolved.stdout.trim()

    return await buildFileDiffs(
      projectCwd,
      shadowGitDir,
      [fullHash],
      fullHash,
      file => readFile(join(projectCwd, file), 'utf8').catch(() => ''),
    )
  })
}

/**
 * Structured per-file diff between two snapshots (base → target). `+` lines are
 * what `target` adds over `base`; `-` lines what it removes. Same shape and
 * budgets as {@link snapshotDiff}, but reads BOTH sides from the shadow repo so
 * it never touches the working tree.
 */
export async function snapshotDiffBetween(
  projectCwd: string,
  baseHash: string,
  targetHash: string,
): Promise<FileDiff[]> {
  const shadowGitDir = await ensureShadowRepo(projectCwd)
  if (!shadowGitDir) return []
  const base = baseHash.trim()
  const target = targetHash.trim()
  if (
    !/^[0-9a-fA-F]{4,64}$/.test(base) ||
    !/^[0-9a-fA-F]{4,64}$/.test(target)
  ) {
    return []
  }

  return await withLock(shadowGitDir, async () => {
    const [baseRes, targetRes] = await Promise.all([
      gitRun(shadowGitDir, projectCwd, [
        'rev-parse',
        '--verify',
        `${base}^{commit}`,
      ]),
      gitRun(shadowGitDir, projectCwd, [
        'rev-parse',
        '--verify',
        `${target}^{commit}`,
      ]),
    ])
    if (baseRes.code !== 0 || targetRes.code !== 0) return []
    const baseFull = baseRes.stdout.trim()
    const targetFull = targetRes.stdout.trim()

    return await buildFileDiffs(
      projectCwd,
      shadowGitDir,
      [baseFull, targetFull],
      baseFull,
      file =>
        gitRun(shadowGitDir, projectCwd, [
          'show',
          `${targetFull}:${file}`,
        ]).then(r => (r.code === 0 ? r.stdout : '')),
    )
  })
}
