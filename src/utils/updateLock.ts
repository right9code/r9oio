import { randomUUID } from 'crypto'
import type { Stats } from 'fs'
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rmdir,
  unlink,
  writeFile,
} from 'fs/promises'
import { dirname, join, resolve } from 'path'
import { getErrnoCode } from './errors.js'

const OWNER_PATTERN = /^owner-[0-9a-f-]{36}\.lease$/i

type LeaseOwner = {
  lockPath: string
  token: string
  leasePath: string
}

export type UpdateLockOptions = {
  getLockPath: () => string
  staleMs: number
  heartbeatMs: number
  onHeartbeatError?: (error: unknown) => void
  isProcessAlive?: (pid: number) => boolean
}

export type UpdateLockHandoff = {
  lockPath: string
  token: string
  pid: number
}

/** Environment variables understood by dependency-free nested installers. */
export function createUpdateLockHandoffEnvironment(
  handoff: UpdateLockHandoff,
  prefix: 'TAU_UPDATE_LOCK' | 'TAU_LOCAL_UPDATE_LOCK',
): Record<string, string> {
  return {
    [`${prefix}_PATH`]: handoff.lockPath,
    [`${prefix}_TOKEN`]: handoff.token,
    [`${prefix}_PID`]: String(handoff.pid),
  }
}

// These calls never request bigint stats, so mtimeMs/dev/ino are numbers.
type FileStats = Stats

function sameFile(left: FileStats, right: FileStats): boolean {
  // dev+ino is the kernel identity on normal local filesystems. Some virtual
  // filesystems report zero, so retain a conservative metadata fallback.
  if (left.dev !== 0 || left.ino !== 0 || right.dev !== 0 || right.ino !== 0) {
    return left.dev === right.dev && left.ino === right.ino
  }
  return (
    left.birthtimeMs === right.birthtimeMs &&
    left.mtimeMs === right.mtimeMs &&
    left.size === right.size &&
    left.mode === right.mode
  )
}

function isMissing(error: unknown): boolean {
  return getErrnoCode(error) === 'ENOENT'
}

function isContended(error: unknown): boolean {
  const code = getErrnoCode(error)
  return (
    code === 'EEXIST' ||
    code === 'ENOTEMPTY' ||
    code === 'EACCES' ||
    code === 'EPERM'
  )
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    const code = getErrnoCode(error)
    if (code === 'ESRCH') return false
    // EPERM means the process exists but cannot be signalled. Unknown probe
    // failures also fail closed rather than stealing a potentially live lock.
    return true
  }
}

/**
 * Cross-process updater lease backed by a directory and per-acquisition UUID.
 * A delayed stale contender can remove only the UUID it observed; rmdir then
 * refuses to remove any replacement directory containing a new owner's UUID.
 */
export class UpdateLock {
  private owner: LeaseOwner | undefined

  constructor(private readonly options: UpdateLockOptions) {}

  getHandoff(): UpdateLockHandoff | null {
    return this.owner
      ? {
          lockPath: resolve(this.owner.lockPath),
          token: this.owner.token,
          pid: process.pid,
        }
      : null
  }

  async acquire(): Promise<boolean> {
    if (this.owner) return false
    const lockPath = this.options.getLockPath()

    // Serialize one-time migration of the old regular-file lock. This gate
    // uses the token-directory protocol too, so its own recovery is race-safe.
    const gate = await this.acquireDirectoryLease(`${lockPath}.acquire`)
    if (!gate) return false
    try {
      const owner = await this.acquireMainLease(lockPath)
      if (!owner) return false
      this.owner = owner
      return true
    } finally {
      await this.releaseOwner(gate)
    }
  }

  async release(): Promise<void> {
    const owner = this.owner
    this.owner = undefined
    if (owner) await this.releaseOwner(owner)
  }

  startHeartbeat(): () => Promise<void> {
    const owner = this.owner
    let inFlight = Promise.resolve()
    const timer = setInterval(() => {
      inFlight = inFlight.then(async () => {
        if (!owner || this.owner?.token !== owner.token) return
        let handle
        try {
          // This UUID path is never reused. A replacement therefore receives
          // no timestamp update if this process loses ownership.
          handle = await open(owner.leasePath, 'r+')
          const now = new Date()
          await handle.utimes(now, now)
        } catch (error) {
          if (!isMissing(error)) this.options.onHeartbeatError?.(error)
        } finally {
          await handle?.close().catch(() => {})
        }
      })
    }, this.options.heartbeatMs)

    timer.unref()
    return async () => {
      clearInterval(timer)
      await inFlight
    }
  }

  private async acquireMainLease(lockPath: string): Promise<LeaseOwner | null> {
    const fresh = await this.tryCreate(lockPath)
    if (fresh) return fresh

    let lockStats: FileStats
    try {
      lockStats = await lstat(lockPath)
    } catch (error) {
      if (isMissing(error)) return this.tryCreate(lockPath)
      throw error
    }

    const recovered = lockStats.isDirectory()
      ? await this.recoverDirectory(lockPath, lockStats)
      : lockStats.isFile()
        ? await this.recoverLegacyFile(lockPath, lockStats)
        : false
    return recovered ? this.tryCreate(lockPath) : null
  }

  private async acquireDirectoryLease(
    lockPath: string,
  ): Promise<LeaseOwner | null> {
    const fresh = await this.tryCreate(lockPath)
    if (fresh) return fresh

    let lockStats: FileStats
    try {
      lockStats = await lstat(lockPath)
    } catch (error) {
      if (isMissing(error)) return this.tryCreate(lockPath)
      throw error
    }
    if (!lockStats.isDirectory()) return null
    return (await this.recoverDirectory(lockPath, lockStats))
      ? this.tryCreate(lockPath)
      : null
  }

  private async tryCreate(lockPath: string): Promise<LeaseOwner | null> {
    const token = randomUUID()
    const owner = {
      lockPath,
      token,
      leasePath: join(lockPath, `owner-${token}.lease`),
    }

    const createDirectory = async (): Promise<boolean> => {
      try {
        await mkdir(lockPath)
        return true
      } catch (error) {
        if (getErrnoCode(error) === 'EEXIST') return false
        throw error
      }
    }

    let created: boolean
    try {
      created = await createDirectory()
    } catch (error) {
      if (!isMissing(error)) throw error
      await mkdir(dirname(lockPath), { recursive: true })
      created = await createDirectory()
    }
    if (!created) return null

    try {
      await writeFile(
        owner.leasePath,
        JSON.stringify({ token, pid: process.pid, acquiredAt: Date.now() }),
        { encoding: 'utf8', flag: 'wx' },
      )
      return owner
    } catch (error) {
      // No lease is owned until the UUID file exists. A replacement UUID makes
      // this cleanup rmdir fail rather than removing the replacement.
      await rmdir(lockPath).catch(() => {})
      if (isMissing(error) || isContended(error)) return null
      throw error
    }
  }

  private async recoverDirectory(
    lockPath: string,
    observedDirectory: FileStats,
  ): Promise<boolean> {
    let entries
    try {
      entries = await readdir(lockPath, { withFileTypes: true })
    } catch (error) {
      if (isMissing(error)) return true
      throw error
    }

    if (entries.length === 0) {
      let recheck: FileStats
      try {
        recheck = await lstat(lockPath)
      } catch (error) {
        if (isMissing(error)) return true
        throw error
      }
      if (
        !recheck.isDirectory() ||
        !sameFile(observedDirectory, recheck) ||
        Date.now() - recheck.mtimeMs < this.options.staleMs
      ) {
        return false
      }
      return this.removeEmptyDirectory(lockPath)
    }

    const staleOwners: Array<{ path: string; stats: FileStats }> = []
    for (const entry of entries) {
      if (!entry.isFile() || !OWNER_PATTERN.test(entry.name)) return false
      const path = join(lockPath, entry.name)
      let stats: FileStats
      try {
        stats = await lstat(path)
      } catch (error) {
        if (isMissing(error)) continue
        throw error
      }
      if (!stats.isFile() || Date.now() - stats.mtimeMs < this.options.staleMs) {
        return false
      }
      const ownerPid = await this.readOwnerPid(path)
      if (ownerPid && this.isProcessAlive(ownerPid)) return false
      staleOwners.push({ path, stats })
    }

    for (const stale of staleOwners) {
      let recheck: FileStats
      try {
        recheck = await lstat(stale.path)
      } catch (error) {
        if (isMissing(error)) continue
        throw error
      }
      if (
        !recheck.isFile() ||
        !sameFile(stale.stats, recheck) ||
        Date.now() - recheck.mtimeMs < this.options.staleMs
      ) {
        return false
      }
      const ownerPid = await this.readOwnerPid(stale.path)
      if (ownerPid && this.isProcessAlive(ownerPid)) return false
      try {
        await unlink(stale.path)
      } catch (error) {
        if (!isMissing(error)) throw error
      }
    }
    return this.removeEmptyDirectory(lockPath)
  }

  private async removeEmptyDirectory(lockPath: string): Promise<boolean> {
    try {
      await rmdir(lockPath)
      return true
    } catch (error) {
      if (isMissing(error)) return true
      if (isContended(error)) return false
      throw error
    }
  }

  private async recoverLegacyFile(
    lockPath: string,
    observed: FileStats,
  ): Promise<boolean> {
    if (Date.now() - observed.mtimeMs < this.options.staleMs) return false
    const initialOwnerPid = await this.readLegacyOwnerPid(lockPath)
    if (initialOwnerPid && this.isProcessAlive(initialOwnerPid)) return false

    const quarantine = `${lockPath}.legacy-stale-${randomUUID()}`
    let handle
    try {
      handle = await open(lockPath, 'r')
      const opened = await handle.stat()
      const recheck = await lstat(lockPath)
      if (
        !recheck.isFile() ||
        !sameFile(observed, opened) ||
        !sameFile(opened, recheck) ||
        Date.now() - recheck.mtimeMs < this.options.staleMs
      ) {
        return false
      }
      const recheckedOwnerPid = await this.readLegacyOwnerPid(lockPath)
      if (recheckedOwnerPid && this.isProcessAlive(recheckedOwnerPid)) {
        return false
      }

      // Verify the inode again after the atomic rename. Only that quarantined
      // identity is ever unlinked; the shared lock pathname is never unlinked.
      await rename(lockPath, quarantine)
      const moved = await lstat(quarantine)
      if (!moved.isFile() || !sameFile(opened, moved)) {
        await this.restoreQuarantine(quarantine, lockPath)
        return false
      }
    } catch (error) {
      if (isMissing(error)) return true
      throw error
    } finally {
      await handle?.close().catch(() => {})
    }

    await unlink(quarantine)
    return true
  }

  private async restoreQuarantine(
    quarantine: string,
    lockPath: string,
  ): Promise<void> {
    try {
      // Hard-link restore is create-if-absent and cannot overwrite a lock that
      // appeared while the legacy inode was being checked.
      await link(quarantine, lockPath)
      await unlink(quarantine)
    } catch {
      // Preserve an identity that failed verification rather than deleting it.
    }
  }

  private isProcessAlive(pid: number): boolean {
    return (this.options.isProcessAlive ?? processIsAlive)(pid)
  }

  private async readOwnerPid(path: string): Promise<number | null> {
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8')) as {
        pid?: unknown
      }
      return typeof parsed.pid === 'number' && Number.isSafeInteger(parsed.pid)
        ? parsed.pid
        : null
    } catch (error) {
      if (isMissing(error) || error instanceof SyntaxError) return null
      throw error
    }
  }

  private async readLegacyOwnerPid(path: string): Promise<number | null> {
    try {
      const value = (await readFile(path, 'utf8')).trim()
      if (!/^\d+$/.test(value)) return null
      const pid = Number(value)
      return Number.isSafeInteger(pid) && pid > 0 ? pid : null
    } catch (error) {
      if (isMissing(error)) return null
      throw error
    }
  }

  private async releaseOwner(owner: LeaseOwner): Promise<void> {
    try {
      await unlink(owner.leasePath)
    } catch (error) {
      if (!isMissing(error)) throw error
    }
    // A replacement UUID keeps the directory non-empty, making this safe.
    await this.removeEmptyDirectory(owner.lockPath)
  }
}
