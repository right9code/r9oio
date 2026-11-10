/**
 * Overlay sandbox service — cumulative-diff sandbox for agent file edits.
 *
 * While active, every write the agent issues through tau's FsOperations
 * layer lands in a per-project overlay directory instead of the real
 * working tree. Reads read through: overlay content wins, real content
 * serves everything else. Deletes write tombstone markers so the file
 * reads as gone without touching the real tree.
 *
 * The user reviews the cumulative diff and applies (copy overlay over the
 * real tree) or rejects (delete the overlay). This is the Plandex-style
 * "changes never touch your files until you approve them" model, layered
 * on tau's existing FS abstraction (see utils/fsOperations.ts) so every
 * tool — Edit, Write, NotebookEdit, subagents — is captured with no
 * per-tool patches.
 *
 * v1 limitations (documented):
 *   - Shell commands (Bash/PowerShell) are NOT captured: they still see and
 *     modify the real tree. TAU_SANDBOX=1 is set so scripts can detect it.
 *   - Symlink create/read operations pass through to the real FS.
 *   - Activation is per-session; it is not restored after a restart.
 */
import envPaths from 'env-paths'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs'
import { mkdir, readFile, rm, writeFile } from 'fs/promises'
import { dirname, join, relative, resolve } from 'path'
import { formatPatch, structuredPatch } from 'diff'

import {
  getFsImplementation,
  setFsImplementation,
  setOriginalFsImplementation,
  type FsOperations,
} from '../../utils/fsOperations.js'
import { djb2Hash } from '../../utils/hash.js'
import { getCwd } from '../../utils/cwd.js'

const paths = envPaths('claude-cli')
const MAX_SANITIZED_LENGTH = 200
const PER_FILE_DIFF_BUDGET = 200 * 1024
export const TOMBSTONE_SUFFIX = '.tau-tombstone'

export type OverlayChangeStatus = 'added' | 'deleted' | 'modified'

export type OverlayChange = {
  /** Path relative to the project cwd. */
  file: string
  status: OverlayChangeStatus
  binary: boolean
  additions: number
  deletions: number
  /** Unified diff text. Empty when binary. */
  patch: string
  /** True when the patch was elided for size. */
  truncated?: boolean
}

export type OverlayState = {
  active: boolean
  root: string | null
  projectCwd: string | null
}

// ---------------------------------------------------------------------------
// Module state (agentFileClaims pattern: plain module-level state, readable
// from tools without any React/context plumbing).
// ---------------------------------------------------------------------------

let activeState: OverlayState | null = null

// React has no way to observe a module-level variable, so the status bar
// subscribes to this revision counter and re-reads on every bump. Kept in the
// service (rather than the component) because sandbox writes are what move the
// count, and they happen far from any render.
let overlayRevision = 0
const overlayListeners = new Set<() => void>()
let pendingCacheRevision = -1
let pendingCacheValue = 0

export function subscribeOverlayState(listener: () => void): () => void {
  overlayListeners.add(listener)
  return () => {
    overlayListeners.delete(listener)
  }
}

export function getOverlayRevision(): number {
  return overlayRevision
}

function notifyOverlayStateChanged(): void {
  overlayRevision++
  for (const listener of overlayListeners) listener()
}

export function isOverlayActive(): boolean {
  return activeState !== null
}

/**
 * Cached-safe read for `useSyncExternalStore`: returns a primitive that only
 * changes when the pending count does, so an unchanged walk cannot loop React.
 */
export function getPendingSnapshotCached(): number {
  if (pendingCacheRevision !== overlayRevision) {
    pendingCacheValue = getPendingChangeCountSync()
    pendingCacheRevision = overlayRevision
  }
  return pendingCacheValue
}

/**
 * Sandbox writes happen inside the FS impl, which is where the count moves, so
 * bump the revision from there. The count itself stays lazy - it is only read
 * while the status bar is on screen.
 */
function noteOverlayWrite(): void {
  notifyOverlayStateChanged()
}

export function getOverlayRoot(): string | null {
  return activeState?.root ?? null
}

export function getOverlayProjectCwd(): string | null {
  return activeState?.projectCwd ?? null
}

// ---------------------------------------------------------------------------
// Path mapping
// ---------------------------------------------------------------------------

function sanitizePath(name: string): string {
  const sanitized = name.replace(/[^a-zA-Z0-9]/g, '-')
  if (sanitized.length <= MAX_SANITIZED_LENGTH) return sanitized
  return `${sanitized.slice(0, MAX_SANITIZED_LENGTH)}-${Math.abs(djb2Hash(name)).toString(36)}`
}

function getOverlayRootFor(projectCwd: string): string {
  return join(paths.data, 'overlays', sanitizePath(projectCwd))
}

function enoent(path: string): never {
  const e = new Error(`ENOENT: no such file or directory, open '${path}'`) as Error & {
    code?: string
  }
  e.code = 'ENOENT'
  throw e
}

function makeTombstonePath(overlayPath: string): string {
  return overlayPath + TOMBSTONE_SUFFIX
}

/**
 * Maps a real-tree path to its overlay counterpart. Returns null when the
 * path is outside the captured project — callers pass such paths through
 * to the real FS untouched.
 */
function mapToOverlay(state: OverlayState, realPath: string): string | null {
  const abs = resolve(state.projectCwd!, realPath)
  const rel = relative(state.projectCwd!, abs)
  if (rel === '' || rel.startsWith('..')) return null
  return join(state.root!, rel)
}

type ReadResolution = 'overlay' | 'real' | 'tombstoned'

function resolveRead(state: OverlayState, realPath: string): ReadResolution {
  const overlayPath = mapToOverlay(state, realPath)
  if (!overlayPath) return 'real'
  if (existsSync(makeTombstonePath(overlayPath))) return 'tombstoned'
  if (existsSync(overlayPath)) return 'overlay'
  return 'real'
}

// ---------------------------------------------------------------------------
// SandboxFsOperations — the FsOperations implementation swapped in while
// the overlay is active. All state comes from the captured OverlayState so
// subagent cwd changes never shift the overlay root mid-session.
// ---------------------------------------------------------------------------

class SandboxFsOperations implements FsOperations {
  private readonly real: FsOperations
  private readonly overlayDirs = new Set<string>()

  constructor(private readonly state: OverlayState, real: FsOperations) {
    this.real = real
  }

  private toOverlay(realPath: string): string | null {
    return mapToOverlay(this.state, realPath)
  }

  private readRes(realPath: string): ReadResolution {
    return resolveRead(this.state, realPath)
  }

  // ----- Reads: overlay-first, tombstoned → ENOENT, else real -----

  readFileSync(path: string, options: { encoding: BufferEncoding }): string {
    const res = this.readRes(path)
    if (res === 'tombstoned') enoent(path)
    const overlayPath = this.toOverlay(path)
    if (overlayPath && res === 'overlay') {
      return this.real.readFileSync(overlayPath, options)
    }
    return this.real.readFileSync(path, options)
  }

  readFileBytesSync(path: string): Buffer {
    const res = this.readRes(path)
    if (res === 'tombstoned') enoent(path)
    const overlayPath = this.toOverlay(path)
    if (overlayPath && res === 'overlay') {
      return this.real.readFileBytesSync(overlayPath)
    }
    return this.real.readFileBytesSync(path)
  }

  async readFile(
    path: string,
    options: { encoding: BufferEncoding },
  ): Promise<string> {
    const res = this.readRes(path)
    if (res === 'tombstoned') enoent(path)
    const overlayPath = this.toOverlay(path)
    if (overlayPath && res === 'overlay') {
      return readFile(overlayPath, { encoding: options.encoding })
    }
    return this.real.readFile(path, options)
  }

  async readFileBytes(path: string, maxBytes?: number): Promise<Buffer> {
    const res = this.readRes(path)
    if (res === 'tombstoned') enoent(path)
    const overlayPath = this.toOverlay(path)
    if (overlayPath && res === 'overlay') {
      const buf = await readFile(overlayPath)
      return maxBytes !== undefined ? buf.subarray(0, maxBytes) : buf
    }
    return this.real.readFileBytes(path, maxBytes)
  }

  readSync(
    path: string,
    options: { length: number },
  ): { buffer: Buffer; bytesRead: number } {
    const res = this.readRes(path)
    if (res === 'tombstoned') enoent(path)
    const overlayPath = this.toOverlay(path)
    if (overlayPath && res === 'overlay') {
      return this.real.readSync(overlayPath, options)
    }
    return this.real.readSync(path, options)
  }

  // ----- Stat family: overlay hit wins, tombstoned → absent -----

  private statTarget(path: string): string {
    const res = this.readRes(path)
    if (res === 'tombstoned') enoent(path)
    if (res === 'overlay') {
      const overlayPath = this.toOverlay(path)!
      return overlayPath
    }
    return path
  }

  statSync(path: string) {
    return this.real.statSync(this.statTarget(path))
  }

  lstatSync(path: string) {
    return this.real.lstatSync(this.statTarget(path))
  }

  async stat(path: string) {
    return this.real.stat(this.statTarget(path))
  }

  existsSync(path: string): boolean {
    const res = this.readRes(path)
    if (res === 'tombstoned') return false
    if (res === 'overlay') return true
    return this.real.existsSync(path)
  }

  // ----- Writes: redirect to overlay, clear tombstone -----

  private writeTarget(path: string): string {
    const overlayPath = this.toOverlay(path)
    if (!overlayPath) return path // outside the project — passthrough
    mkdirSync(dirname(overlayPath), { recursive: true })
    const tombstone = makeTombstonePath(overlayPath)
    if (existsSync(tombstone)) this.real.rmSync(tombstone, { force: true })
    noteOverlayWrite()
    return overlayPath
  }

  writeFileSync(
    path: string,
    data: string,
    options?: {
      encoding?: BufferEncoding
      mode?: number
      flush?: boolean
      flag?: string
    },
  ): void {
    this.real.writeFileSync(this.writeTarget(path), data, options)
  }

  appendFileSync(path: string, data: string, options?: { mode?: number }): void {
    this.real.appendFileSync(this.writeTarget(path), data, options)
  }

  createWriteStream(path: string) {
    const target = this.writeTarget(path)
    return this.real.createWriteStream(target)
  }

  chmodSync(path: string, mode: number): void {
    this.real.chmodSync(this.writeTarget(path), mode)
  }

  copyFileSync(src: string, dest: string): void {
    // Read through the source (overlay-aware), write dest to overlay.
    const res = this.readRes(src)
    const srcOverlay = this.toOverlay(src)
    const srcPath = srcOverlay && res === 'overlay' ? srcOverlay : src
    this.real.copyFileSync(srcPath, this.writeTarget(dest))
  }

  // ----- Deletes: tombstone in overlay, remove overlay copy if present -----

  private deleteTarget(path: string): 'tombstoned' | 'passthrough' {
    const overlayPath = this.toOverlay(path)
    if (!overlayPath) return 'passthrough' // outside project — caller passthrough
    mkdirSync(dirname(overlayPath), { recursive: true })
    if (this.real.existsSync(overlayPath)) {
      this.real.rmSync(overlayPath, { force: true })
    }
    writeFileSync(makeTombstonePath(overlayPath), '')
    noteOverlayWrite()
    return 'tombstoned'
  }

  unlinkSync(path: string): void {
    if (this.deleteTarget(path) === 'passthrough') this.real.unlinkSync(path)
  }

  async unlink(path: string): Promise<void> {
    if (this.deleteTarget(path) === 'passthrough') await this.real.unlink(path)
  }

  rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void {
    if (this.deleteTarget(path) === 'passthrough') this.real.rmSync(path, options)
  }

  async rm(
    path: string,
    options?: { recursive?: boolean; force?: boolean },
  ): Promise<void> {
    if (this.deleteTarget(path) === 'passthrough') await this.real.rm(path, options)
  }

  rmdirSync(path: string): void {
    if (this.deleteTarget(path) === 'passthrough') this.real.rmdirSync(path)
  }

  async rmdir(path: string): Promise<void> {
    if (this.deleteTarget(path) === 'passthrough') await this.real.rmdir(path)
  }

  // ----- Renames: copy-through into overlay + tombstone source -----

  /**
   * Tau's atomic writer renames `<target>.tmp.<pid>.<timestamp>` onto the
   * target. That rename is a CONTENT-PLACEMENT, not a project-file move:
   * tombstoning the temp path would record a bogus deletion. Only tombstone
   * a source that is not an atomic-write temp.
   */
  private isAtomicWriteTemp(path: string): boolean {
    return /\.tmp\.\d+\.\d+(?:\.[^.]+)?$/.test(path)
  }

  renameSync(oldPath: string, newPath: string): void {
    const oldOverlay = this.toOverlay(oldPath)
    const res = this.readRes(oldPath)
    if (res === 'tombstoned') enoent(oldPath)
    if (!oldOverlay) {
      // Outside the project — v1 passthrough.
      this.real.renameSync(oldPath, newPath)
      return
    }
    this.copyThroughForRename(oldPath, oldOverlay, res)
    const dest = this.writeTarget(newPath)
    this.real.renameSync(oldOverlay, dest)
    if (!this.isAtomicWriteTemp(oldPath)) {
      this.deleteTarget(oldPath)
    }
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const oldOverlay = this.toOverlay(oldPath)
    const res = this.readRes(oldPath)
    if (res === 'tombstoned') enoent(oldPath)
    if (!oldOverlay) {
      await this.real.rename(oldPath, newPath)
      return
    }
    this.copyThroughForRename(oldPath, oldOverlay, res)
    const dest = this.writeTarget(newPath)
    await this.real.rename(oldOverlay, dest)
    if (!this.isAtomicWriteTemp(oldPath)) {
      this.deleteTarget(oldPath)
    }
  }

  private copyThroughForRename(
    oldPath: string,
    oldOverlay: string,
    res: ReadResolution,
  ): void {
    // If the source had no overlay copy yet (read-through real content),
    // materialize it in the overlay first so the rename has a source file.
    if (res === 'real' && this.real.existsSync(oldPath)) {
      mkdirSync(dirname(oldOverlay), { recursive: true })
      this.real.copyFileSync(oldPath, oldOverlay)
    }
  }

  // ----- Directories: mkdir mirrors to overlay; readdir merges -----

  mkdirSync(path: string, options?: { mode?: number }): void {
    const overlayPath = this.toOverlay(path)
    if (overlayPath) {
      this.overlayDirs.add(overlayPath)
      mkdirSync(overlayPath, { recursive: true })
    }
    // Also attempt on the real tree so tools that expect the dir (e.g.
    // a dev server) see it. Ignore failure: overlay capture is the point.
    try {
      this.real.mkdirSync(path, options)
    } catch {
      // ignore — dir may already exist
    }
  }

  async mkdir(path: string, options?: { mode?: number }): Promise<void> {
    const overlayPath = this.toOverlay(path)
    if (overlayPath) {
      this.overlayDirs.add(overlayPath)
      await mkdir(overlayPath, { recursive: true })
    }
    try {
      await this.real.mkdir(path, options)
    } catch {
      // ignore
    }
  }

  private mergedEntries(
    realEntries: string[],
    overlayDir: string | null,
    dropTombstoned: boolean,
  ): string[] {
    if (!overlayDir || !existsSync(overlayDir)) return realEntries
    const overlayEntries = readdirSync(overlayDir)
    const out = new Set(realEntries)
    for (const entry of overlayEntries) {
      if (entry.endsWith(TOMBSTONE_SUFFIX)) continue
      out.add(entry)
    }
    if (dropTombstoned) {
      for (const entry of [...out]) {
        if (existsSync(makeTombstonePath(join(overlayDir, entry)))) {
          out.delete(entry)
        }
      }
    }
    return [...out]
  }

  readdirSync(path: string) {
    const realEntries = this.real.readdirSync(path)
    const overlayDir = this.toOverlay(path)
    const merged = this.mergedEntries(
      realEntries.map(e => e.name),
      overlayDir,
      true,
    )
    // Re-stat each merged name against the merged view for type info.
    return merged.map(name => {
      const full = join(path, name)
      const s = statSync(this.statTarget(full))
      return Object.assign(s, { name }) as unknown as import('fs').Dirent
    })
  }

  readdirStringSync(path: string): string[] {
    const realEntries = this.real.readdirStringSync(path)
    const overlayDir = this.toOverlay(path)
    return this.mergedEntries(realEntries, overlayDir, true)
  }

  async readdir(path: string) {
    const realEntries = await this.real.readdir(path)
    const overlayDir = this.toOverlay(path)
    const merged = this.mergedEntries(
      realEntries.map(e => e.name),
      overlayDir,
      true,
    )
    // For names only in the overlay, stat the overlay copy directly.
    const realByName = new Map(realEntries.map(e => [e.name, e] as const))
    const out: import('fs').Dirent[] = []
    for (const name of merged) {
      const fromReal = realByName.get(name)
      if (fromReal) {
        out.push(fromReal)
      } else {
        const s = statSync(join(overlayDir!, name))
        out.push(Object.assign(s, { name }) as unknown as import('fs').Dirent)
      }
    }
    return out
  }

  isDirEmptySync(path: string): boolean {
    return this.readdirSync(path).length === 0
  }

  // ----- v1 pass-throughs (symlinks, links, streams, cwd) -----

  linkSync(target: string, path: string): void {
    this.real.linkSync(target, path)
  }

  symlinkSync(
    target: string,
    path: string,
    type?: 'dir' | 'file' | 'junction',
  ): void {
    this.real.symlinkSync(target, path, type)
  }

  readlinkSync(path: string): string {
    return this.real.readlinkSync(path)
  }

  realpathSync(path: string): string {
    return this.real.realpathSync(path)
  }

  cwd(): string {
    return this.real.cwd()
  }
}

// ---------------------------------------------------------------------------
// Service operations: activate / deactivate / list / apply / reject
// ---------------------------------------------------------------------------

// Serialize diff/apply/reject so a concurrent write can't tear a listing.
let opChain: Promise<unknown> = Promise.resolve()

function withOverlayLock<T>(fn: () => Promise<T>): Promise<T> {
  const result = opChain.then(fn, fn)
  opChain = result.then(
    () => undefined,
    () => undefined,
  )
  return result
}

/**
 * Turns the overlay sandbox on. All agent writes below `projectCwd` start
 * accumulating in the overlay; the real tree is untouched until apply.
 */
export function activateOverlay(projectCwd?: string): OverlayState {
  if (activeState) return activeState
  const cwd = projectCwd ?? getCwd()
  const root = getOverlayRootFor(cwd)
  mkdirSync(root, { recursive: true })
  const state: OverlayState = { active: true, root, projectCwd: cwd }
  activeState = state
  setFsImplementation(new SandboxFsOperations(state, getFsImplementation()))
  notifyOverlayStateChanged()
  return state
}

/**
 * Turns the overlay sandbox off but keeps the accumulated changes on disk
 * (and their tombstones). A later `activateOverlay` picks them back up.
 */
export function deactivateOverlay(): void {
  if (!activeState) return
  setOriginalFsImplementation()
  activeState = null
  notifyOverlayStateChanged()
}

/** True when the overlay dir for this project has accumulated changes. */
function isBinaryFile(path: string): boolean {
  try {
    // NUL-byte sniff on the first 48 KB — same heuristic git uses.
    const buf = readFileSync(path)
    return buf.subarray(0, 49152).includes(0)
  } catch {
    return false
  }
}

/**
 * Enumerates overlay files and tombstones as project-relative paths.
 * Returns { overlayFiles, tombstonedFiles } — the caller composes status.
 */
function collectOverlayPaths(
  state: OverlayState,
): { overlayFiles: string[]; tombstonedFiles: string[] } {
  const overlayFiles: string[] = []
  const tombstonedFiles: string[] = []
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      const rel = relative(state.root!, full)
      if (entry.endsWith(TOMBSTONE_SUFFIX)) {
        tombstonedFiles.push(rel.slice(0, -TOMBSTONE_SUFFIX.length))
        continue
      }
      if (statSync(full).isDirectory()) {
        walk(full)
      } else {
        overlayFiles.push(rel)
      }
    }
  }
  walk(state.root!)
  // A path with both an overlay copy and a tombstone: the copy wins (a
  // delete followed by a re-write), so drop such tombstones.
  const copied = new Set(overlayFiles)
  return {
    overlayFiles,
    tombstonedFiles: tombstonedFiles.filter(f => !copied.has(f)),
  }
}

/**
 * The cumulative diff: every overlay file and tombstone vs the real tree.
 * Real → overlay direction, so `+` lines are what apply would land.
 */
export async function listOverlayChanges(): Promise<OverlayChange[]> {
  if (!activeState) return []
  const state = activeState
  return withOverlayLock(async () => {
    const { overlayFiles, tombstonedFiles } = collectOverlayPaths(state)
    const changes: OverlayChange[] = []
    for (const rel of [...overlayFiles, ...tombstonedFiles]) {
      const overlayPath = join(state.root!, rel)
      const realPath = join(state.projectCwd!, rel)
      const overlayCopyExists = overlayFiles.includes(rel)
      const realExists = existsSync(realPath)
      const status: OverlayChangeStatus = !realExists
        ? 'added'
        : !overlayCopyExists
          ? 'deleted'
          : 'modified'
      if (status === 'deleted') {
        changes.push({
          file: rel,
          status,
          binary: false,
          additions: 0,
          deletions: 0,
          patch: `File deleted (pending in overlay; still present in the real tree until applied).`,
        })
        continue
      }
      if (isBinaryFile(overlayPath)) {
        changes.push({
          file: rel,
          status,
          binary: true,
          additions: 0,
          deletions: 0,
          patch: '',
        })
        continue
      }
      const [before, after] = await Promise.all([
        status === 'added'
          ? Promise.resolve('')
          : readFile(realPath, 'utf8').catch(() => ''),
        readFile(overlayPath, 'utf8'),
      ])
      const total = before.length + after.length
      if (total > PER_FILE_DIFF_BUDGET) {
        changes.push({
          file: rel,
          status,
          binary: false,
          additions: 0,
          deletions: 0,
          patch: `(diff elided: ${total} bytes exceeds per-file budget of ${PER_FILE_DIFF_BUDGET} bytes)`,
          truncated: true,
        })
        continue
      }
      let patch = ''
      try {
        patch = formatPatch(structuredPatch(rel, rel, before, after, '', ''))
      } catch {
        patch = '(diff failed)'
      }
      changes.push({ file: rel, status, binary: false, additions: 0, deletions: 0, patch })
    }
    changes.forEach(c => {
      for (const line of c.patch.split('\n')) {
        if (line.startsWith('+') && !line.startsWith('+++')) c.additions++
        else if (line.startsWith('-') && !line.startsWith('---')) c.deletions++
      }
    })
    return changes.sort((a, b) => a.file.localeCompare(b.file))
  })
}

export type ApplyResult = { applied: number; deleted: number }

/**
 * Applies the overlay onto the real tree: copies every overlay file over
 * its real counterpart (mkdir parents), removes tombstoned files, then
 * clears the overlay and deactivates.
 */
export async function applyOverlay(): Promise<ApplyResult> {
  if (!activeState) return { applied: 0, deleted: 0 }
  const state = activeState
  return withOverlayLock(async () => {
    const { overlayFiles, tombstonedFiles } = collectOverlayPaths(state)
    let applied = 0
    let deleted = 0
    for (const rel of overlayFiles) {
      const overlayPath = join(state.root!, rel)
      const realPath = join(state.projectCwd!, rel)
      mkdirSync(dirname(realPath), { recursive: true })
      await writeFile(realPath, await readFile(overlayPath))
      applied++
    }
    for (const rel of tombstonedFiles) {
      const realPath = join(state.projectCwd!, rel)
      if (existsSync(realPath)) {
        await rm(realPath, { recursive: true, force: true })
      }
      deleted++
    }
    await rm(state.root!, { recursive: true, force: true })
    deactivateOverlay()
    return { applied, deleted }
  })
}

/**
 * Throws away everything accumulated in the overlay. The real tree was
 * never touched, so there is nothing to restore — the overlay dir is
 * simply deleted.
 */
export async function rejectOverlay(): Promise<void> {
  if (!activeState) return
  const state = activeState
  await withOverlayLock(async () => {
    await rm(state.root!, { recursive: true, force: true })
    deactivateOverlay()
  })
}

/**
 * Synchronous pending count for render-path callers (the status bar cannot
 * await). One directory walk plus a tombstone presence check.
 */
export function getPendingChangeCountSync(): number {
  if (!activeState) return 0
  const { overlayFiles, tombstonedFiles } = collectOverlayPaths(activeState)
  return overlayFiles.length + tombstonedFiles.length
}

/** Status for /overlay with no args: is it on, and how much is pending. */
export async function getOverlayStatus(): Promise<{
  active: boolean
  root: string | null
  pending: number
}> {
  if (!activeState) {
    return { active: false, root: null, pending: 0 }
  }
  const { overlayFiles, tombstonedFiles } = collectOverlayPaths(activeState)
  return {
    active: true,
    root: activeState.root,
    pending: overlayFiles.length + tombstonedFiles.length,
  }
}

