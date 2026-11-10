/**
 * Install integrity helpers for the global updater.
 *
 * Interrupted global updates (Windows EPERM cleanup failures, Ctrl-C,
 * antivirus locks) leave two kinds of damage behind:
 *
 *  1. Orphaned `tau` / `claudex` bin shims npm no longer tracks — the next
 *     `npm install -g` aborts with EEXIST on those files.
 *  2. Holes in the installed package's node_modules — the CLI later crashes
 *     with "Cannot find module '<dep>'".
 *
 * These helpers clean only dangling shims before installing, recover from an
 * EEXIST abort with a narrowly targeted retry, and verify/repair the freshly
 * installed tree via the package's own dependency-free
 * scripts/verify-deps.mjs. A healthy launcher remains in place until npm has
 * successfully replaced it, so a network/install failure does not needlessly
 * strand the existing Tau installation without its command.
 */

import { existsSync } from 'fs'
import { lstat, readFile, readlink, realpath, unlink } from 'fs/promises'
import { homedir } from 'os'
import { dirname, join, resolve } from 'path'
import { logForDebugging } from './debug.js'
import { execFileNoThrowWithCwd } from './execFileNoThrow.js'
import { writeToStdout } from './process.js'

const BIN_NAMES = ['tau', 'claudex']
const WIN_EXTS = ['', '.cmd', '.ps1']

/** Package root corresponding to the JavaScript entry that is actually running. */
export function getRunningPackageRoot(
  invokedEntry?: string,
): string | null {
  if (!invokedEntry) {
    const launcherRoot = (
      globalThis as typeof globalThis & { __TAU_PACKAGE_ROOT__?: unknown }
    ).__TAU_PACKAGE_ROOT__
    if (typeof launcherRoot === 'string' && launcherRoot) {
      return resolve(launcherRoot)
    }
    invokedEntry = process.argv[1]
  }
  return invokedEntry ? resolve(dirname(invokedEntry), '..') : null
}

async function comparablePath(
  path: string,
  platform = process.platform,
): Promise<string> {
  let normalized: string
  try {
    normalized = await realpath(path)
  } catch {
    normalized = resolve(path)
  }
  return platform === 'win32' ? normalized.toLowerCase() : normalized
}

/** Compare npm roots canonically so symlinked prefixes and Windows casing work. */
export async function packageRootsMatch(
  left: string,
  right: string,
  platform = process.platform,
): Promise<boolean> {
  const [normalizedLeft, normalizedRight] = await Promise.all([
    comparablePath(left, platform),
    comparablePath(right, platform),
  ])
  return normalizedLeft === normalizedRight
}

/** Bin shim directory for a given npm/bun global prefix. */
function getBinDir(prefix: string, isBun: boolean): string {
  if (isBun) return prefix // `bun pm bin -g` already returns the bin dir
  return process.platform === 'win32' ? prefix : join(prefix, 'bin')
}

type ShimKind = 'ours' | 'dangling' | 'foreign' | 'unknown'

/** Resolve targets from npm's quoted sh/cmd/ps1 launcher templates. */
function getEmbeddedShimTargets(shimPath: string, content: string): string[] {
  const quotedTargets = [
    ...content.matchAll(/"([^"\r\n]*node_modules\/[^"\r\n]+)"/g),
    ...content.matchAll(/'([^'\r\n]*node_modules\/[^'\r\n]+)'/g),
  ]
  const basedirPrefix =
    /^(?:%~dp0%?|%dp0%|\$(?:basedir|\{basedir\}|PSScriptRoot|\{PSScriptRoot\}))(?:\/|$)/i

  return quotedTargets.flatMap(match => {
    let embeddedPath = match[1]
    if (!embeddedPath) return []

    if (basedirPrefix.test(embeddedPath)) {
      embeddedPath = embeddedPath.replace(
        basedirPrefix,
        `${dirname(shimPath)}/`,
      )
    } else if (/[$%`]/.test(embeddedPath)) {
      // An unknown shell variable means we cannot prove where this points.
      return []
    }

    return [resolve(dirname(shimPath), embeddedPath)]
  })
}

/** Decide whether a shim belongs to this package or points at nothing. */
async function classifyShim(
  shimPath: string,
  packageName: string,
): Promise<ShimKind> {
  try {
    const stat = await lstat(shimPath)
    if (stat.isSymbolicLink()) {
      const target = await readlink(shimPath)
      const resolved = resolve(dirname(shimPath), target)
      if (!existsSync(resolved)) return 'dangling'
      return resolved.split('\\').join('/').includes(
        `node_modules/${packageName}/`,
      )
        ? 'ours'
        : 'foreign'
    }
    // npm's sh/cmd/ps1 launchers embed a quoted node_modules target. Resolve
    // the complete token, including absolute/relative prefixes, rather than
    // assuming node_modules is beside the shim. If a custom launcher uses an
    // unknown shell variable, preserve it because its target is unproven.
    const content = (await readFile(shimPath, 'utf8')).split('\\').join('/')
    const targets = getEmbeddedShimTargets(shimPath, content)
    let hasMissingTarget = false
    for (const target of targets) {
      if (!existsSync(target)) {
        hasMissingTarget = true
        continue
      }
      if (
        target
          .split('\\')
          .join('/')
          .includes(`node_modules/${packageName}/`)
      ) {
        return 'ours'
      }
      return 'foreign'
    }
    return hasMissingTarget ? 'dangling' : 'foreign'
  } catch {
    return 'unknown'
  }
}

/**
 * Remove only dangling `tau`/`claudex` launcher shims in the global bin dir.
 * A healthy Tau-owned launcher is intentionally preserved until npm succeeds;
 * removing it here would turn a network or install failure into a broken
 * existing command. A later, confirmed EEXIST failure has its own narrowly
 * scoped removal-and-retry path below.
 */
export async function cleanStaleBinShims(
  prefix: string | null,
  isBun: boolean,
  packageName = MACRO.PACKAGE_URL,
): Promise<void> {
  if (!prefix) return
  const binDir = getBinDir(prefix, isBun)
  const exts = process.platform === 'win32' ? WIN_EXTS : ['']

  for (const name of BIN_NAMES) {
    for (const ext of exts) {
      const shimPath = join(binDir, name + ext)
      if (!existsSync(shimPath)) {
        // existsSync follows symlinks — a dangling symlink reports false
        // but still blocks npm, so check lstat before skipping.
        try {
          await lstat(shimPath)
        } catch {
          continue
        }
      }
      const kind = await classifyShim(shimPath, packageName)
      if (kind === 'dangling') {
        try {
          await unlink(shimPath)
          logForDebugging(`installIntegrity: removed stale shim ${shimPath}`)
        } catch (err) {
          logForDebugging(
            `installIntegrity: could not remove shim ${shimPath}: ${err}`,
          )
        }
      }
    }
  }
}

/**
 * Pull the conflicting file path out of an npm EEXIST failure, e.g.
 *   npm error code EEXIST
 *   npm error File exists: C:\Users\me\AppData\Roaming\npm\claudex
 * Returns null when the failure isn't an EEXIST bin conflict.
 */
export function extractEexistPath(npmOutput: string): string | null {
  if (!/\bEEXIST\b/.test(npmOutput)) return null
  const match = npmOutput.match(/File exists: (.+)/)
  return match?.[1]?.trim() ?? null
}

/**
 * Remove an EEXIST-conflicting Tau shim and its sibling variants.
 * Refuse paths outside the expected global bin directory and foreign files.
 */
export async function removeConflictingShim(
  filePath: string,
  prefix: string | null,
  isBun: boolean,
  packageName = MACRO.PACKAGE_URL,
): Promise<boolean> {
  if (!prefix) return false

  const binDir = resolve(getBinDir(prefix, isBun))
  const basePath = resolve(
    process.platform === 'win32'
      ? filePath.replace(/\.(cmd|ps1)$/i, '')
      : filePath,
  )
  const normalizeForComparison = (value: string) =>
    process.platform === 'win32' ? value.toLowerCase() : value
  const expectedPaths = new Set(
    BIN_NAMES.map(name => normalizeForComparison(resolve(binDir, name))),
  )

  if (!expectedPaths.has(normalizeForComparison(basePath))) {
    logForDebugging(
      `installIntegrity: refused EEXIST path outside Tau's global bin directory: ${filePath}`,
    )
    return false
  }

  const variants =
    process.platform === 'win32'
      ? [
          basePath,
          `${basePath}.cmd`,
          `${basePath}.ps1`,
        ]
      : [basePath]
  let removed = false
  for (const variant of variants) {
    const kind = await classifyShim(variant, packageName)
    if (kind !== 'ours' && kind !== 'dangling') continue
    try {
      await unlink(variant)
      removed = true
      logForDebugging(`installIntegrity: removed conflicting ${variant}`)
    } catch {
      // already gone / never existed
    }
  }
  return removed
}

/** Root directory of the globally installed package, or null. */
export async function getGlobalPackageRoot(): Promise<string | null> {
  const result = await execFileNoThrowWithCwd('npm', ['root', '-g'], {
    cwd: homedir(),
  })
  if (result.code !== 0 || !result.stdout.trim()) return null
  return join(result.stdout.trim(), ...MACRO.PACKAGE_URL.split('/'))
}

/**
 * Verify (and repair, if needed) the dependency tree of an installed copy
 * of the package by running its bundled scripts/verify-deps.mjs. Returns
 * true when the tree is complete. Versions that predate the verifier are
 * trusted as-is.
 */
export async function verifyInstalledPackage(
  packageRoot: string,
  options: { interactive?: boolean; env?: NodeJS.ProcessEnv } = {},
): Promise<boolean> {
  const script = join(packageRoot, 'scripts', 'verify-deps.mjs')
  if (!existsSync(script)) return true

  if (options.interactive) {
    writeToStdout('Verifying installed dependencies...\n')
  }

  const result = await execFileNoThrowWithCwd(
    process.execPath,
    [script, '--repair', '--quiet'],
    {
      cwd: homedir(),
      env: options.env,
      timeout: 10 * 60 * 1000,
      killTreeOnTimeout: true,
    },
  )

  if (options.interactive) {
    const output = `${result.stdout}${result.stderr}`.trim()
    if (output) writeToStdout(`${output}\n`)
  }
  logForDebugging(
    `installIntegrity: verify-deps exited ${result.code} for ${packageRoot}`,
  )
  return result.code === 0
}
