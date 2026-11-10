/**
 * Dependency-free synchronous update lease for lifecycle repair scripts.
 *
 * Synchronous npm/node-gyp children block the event loop, so timestamp-only
 * heartbeats are insufficient here. Stale recovery therefore requires both
 * an expired timestamp and a dead owner PID. The directory/token layout is
 * intentionally identical to src/utils/updateLock.ts and tau-installer.
 */

import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, posix, resolve, win32 } from 'node:path';

export const UPDATE_LOCK_STALE_MS = 15 * 60 * 1000;
const OWNER_PATTERN = /^owner-[0-9a-f-]{36}\.lease$/i;

function errnoCode(error) {
  return error && typeof error === 'object' && typeof error.code === 'string'
    ? error.code
    : undefined;
}

function isMissing(error) {
  return errnoCode(error) === 'ENOENT';
}

function isContended(error) {
  return ['EEXIST', 'ENOTEMPTY', 'EACCES', 'EPERM'].includes(errnoCode(error));
}

function sameFile(left, right) {
  if (left.dev !== 0 || left.ino !== 0 || right.dev !== 0 || right.ino !== 0) {
    return left.dev === right.dev && left.ino === right.ino;
  }
  return (
    left.birthtimeMs === right.birthtimeMs &&
    left.mtimeMs === right.mtimeMs &&
    left.size === right.size &&
    left.mode === right.mode
  );
}

function defaultProcessIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (errnoCode(error) === 'ESRCH') return false;
    // EPERM means it exists; unknown failures fail closed as well.
    return true;
  }
}

function readJsonOwnerPid(path) {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    return Number.isSafeInteger(value?.pid) && value.pid > 0
      ? value.pid
      : null;
  } catch (error) {
    if (isMissing(error) || error instanceof SyntaxError) return null;
    throw error;
  }
}

function readLegacyOwnerPid(path) {
  try {
    const value = readFileSync(path, 'utf8').trim();
    if (!/^\d+$/.test(value)) return null;
    const pid = Number(value);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

function removeEmptyDirectory(path) {
  try {
    rmdirSync(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return true;
    if (isContended(error)) return false;
    throw error;
  }
}

function tryCreate(lockPath, options) {
  const token = options.randomUUIDImpl();
  const leasePath = join(lockPath, `owner-${token}.lease`);
  const mkdirExclusive = () => {
    try {
      mkdirSync(lockPath);
      return true;
    } catch (error) {
      if (errnoCode(error) === 'EEXIST') return false;
      throw error;
    }
  };

  let created;
  try {
    created = mkdirExclusive();
  } catch (error) {
    if (!isMissing(error)) throw error;
    mkdirSync(dirname(lockPath), { recursive: true });
    created = mkdirExclusive();
  }
  if (!created) return null;

  try {
    writeFileSync(
      leasePath,
      JSON.stringify({
        token,
        pid: options.pid,
        acquiredAt: options.now(),
      }),
      { encoding: 'utf8', flag: 'wx' },
    );
    return {
      lockPath,
      token,
      pid: options.pid,
      leasePath,
      borrowed: false,
    };
  } catch (error) {
    try {
      rmdirSync(lockPath);
    } catch {
      // A replacement owner keeps the directory non-empty.
    }
    if (isMissing(error) || isContended(error)) return null;
    throw error;
  }
}

function recoverDirectory(lockPath, observedDirectory, options) {
  let entries;
  try {
    entries = readdirSync(lockPath, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return true;
    throw error;
  }

  if (entries.length === 0) {
    let recheck;
    try {
      recheck = lstatSync(lockPath);
    } catch (error) {
      if (isMissing(error)) return true;
      throw error;
    }
    if (
      !recheck.isDirectory() ||
      !sameFile(observedDirectory, recheck) ||
      options.now() - recheck.mtimeMs < options.staleMs
    ) {
      return false;
    }
    return removeEmptyDirectory(lockPath);
  }

  const staleOwners = [];
  for (const entry of entries) {
    if (!entry.isFile() || !OWNER_PATTERN.test(entry.name)) return false;
    const path = join(lockPath, entry.name);
    let stats;
    try {
      stats = lstatSync(path);
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
    if (!stats.isFile() || options.now() - stats.mtimeMs < options.staleMs) {
      return false;
    }
    const ownerPid = readJsonOwnerPid(path);
    if (ownerPid && options.isProcessAliveImpl(ownerPid)) return false;
    staleOwners.push({ path, stats });
  }

  for (const stale of staleOwners) {
    let recheck;
    try {
      recheck = lstatSync(stale.path);
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
    if (
      !recheck.isFile() ||
      !sameFile(stale.stats, recheck) ||
      options.now() - recheck.mtimeMs < options.staleMs
    ) {
      return false;
    }
    const ownerPid = readJsonOwnerPid(stale.path);
    if (ownerPid && options.isProcessAliveImpl(ownerPid)) return false;
    try {
      unlinkSync(stale.path);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
  return removeEmptyDirectory(lockPath);
}

function restoreQuarantine(quarantine, lockPath) {
  try {
    linkSync(quarantine, lockPath);
    unlinkSync(quarantine);
  } catch {
    // Preserve the quarantined identity if a safe restore is impossible.
  }
}

function recoverLegacyFile(lockPath, observed, options) {
  if (options.now() - observed.mtimeMs < options.staleMs) return false;
  const ownerPid = readLegacyOwnerPid(lockPath);
  if (ownerPid && options.isProcessAliveImpl(ownerPid)) return false;

  const quarantine = `${lockPath}.legacy-stale-${options.randomUUIDImpl()}`;
  let handle;
  try {
    handle = openSync(lockPath, 'r');
    const opened = fstatSync(handle);
    const recheck = lstatSync(lockPath);
    if (
      !recheck.isFile() ||
      !sameFile(observed, opened) ||
      !sameFile(opened, recheck) ||
      options.now() - recheck.mtimeMs < options.staleMs
    ) {
      return false;
    }
    const recheckedPid = readLegacyOwnerPid(lockPath);
    if (recheckedPid && options.isProcessAliveImpl(recheckedPid)) return false;

    renameSync(lockPath, quarantine);
    const moved = lstatSync(quarantine);
    if (!moved.isFile() || !sameFile(opened, moved)) {
      restoreQuarantine(quarantine, lockPath);
      return false;
    }
  } catch (error) {
    if (isMissing(error)) return true;
    throw error;
  } finally {
    if (handle !== undefined) closeSync(handle);
  }

  unlinkSync(quarantine);
  return true;
}

function acquireDirectory(lockPath, options) {
  const fresh = tryCreate(lockPath, options);
  if (fresh) return fresh;
  let observed;
  try {
    observed = lstatSync(lockPath);
  } catch (error) {
    if (isMissing(error)) return tryCreate(lockPath, options);
    throw error;
  }
  if (!observed.isDirectory()) return null;
  return recoverDirectory(lockPath, observed, options)
    ? tryCreate(lockPath, options)
    : null;
}

function acquireMain(lockPath, options) {
  const fresh = tryCreate(lockPath, options);
  if (fresh) return fresh;
  let observed;
  try {
    observed = lstatSync(lockPath);
  } catch (error) {
    if (isMissing(error)) return tryCreate(lockPath, options);
    throw error;
  }
  const recovered = observed.isDirectory()
    ? recoverDirectory(lockPath, observed, options)
    : observed.isFile()
      ? recoverLegacyFile(lockPath, observed, options)
      : false;
  return recovered ? tryCreate(lockPath, options) : null;
}

function inspectHandoff({ env, envPrefix, platform, isProcessAliveImpl }) {
  const path = env[`${envPrefix}_PATH`];
  const token = env[`${envPrefix}_TOKEN`];
  const pidText = env[`${envPrefix}_PID`];
  const supplied = [path, token, pidText].filter(value => value !== undefined).length;
  if (supplied === 0) return { status: 'none' };
  if (supplied !== 3 || !OWNER_PATTERN.test(`owner-${token}.lease`)) {
    return { status: 'invalid' };
  }
  const pid = /^\d+$/.test(pidText) ? Number(pidText) : NaN;
  const pathIsAbsolute = platform === 'win32'
    ? win32.isAbsolute(path)
    : posix.isAbsolute(path);
  if (
    !Number.isSafeInteger(pid) ||
    pid <= 0 ||
    !pathIsAbsolute
  ) {
    return { status: 'invalid' };
  }

  const leasePath = join(path, `owner-${token}.lease`);
  try {
    const lockStats = lstatSync(path);
    const leaseStats = lstatSync(leasePath);
    const contents = JSON.parse(readFileSync(leasePath, 'utf8'));
    if (
      !lockStats.isDirectory() ||
      !leaseStats.isFile() ||
      contents?.token !== token ||
      contents?.pid !== pid ||
      !isProcessAliveImpl(pid)
    ) {
      return { status: 'invalid' };
    }
  } catch {
    return { status: 'invalid' };
  }
  return {
    status: 'borrowed',
    lease: { lockPath: path, token, pid, leasePath, borrowed: true },
  };
}

export function getGlobalUpdateLockPath(env = process.env, homeDirectory = homedir()) {
  const configured = env.CLAUDE_CONFIG_DIR?.trim();
  const configHome = configured ? resolve(configured) : join(homeDirectory, '.claude');
  return join(configHome, '.update.lock');
}

export function getManagedLocalUpdateLockPath(projectRoot) {
  return join(dirname(resolve(projectRoot)), '.local-update.lock');
}

export function leaseEnvironment(lease, envPrefix) {
  return {
    [`${envPrefix}_PATH`]: lease.lockPath,
    [`${envPrefix}_TOKEN`]: lease.token,
    [`${envPrefix}_PID`]: String(lease.pid),
  };
}

/** Acquire or borrow a lease. No heartbeat is needed: live PID blocks stealing. */
export function acquireSynchronousUpdateLease({
  lockPath,
  env = process.env,
  envPrefix,
  platform = process.platform,
  staleMs = UPDATE_LOCK_STALE_MS,
  now = Date.now,
  pid = process.pid,
  randomUUIDImpl = randomUUID,
  isProcessAliveImpl = defaultProcessIsAlive,
}) {
  const handoff = inspectHandoff({
    env,
    envPrefix,
    platform,
    isProcessAliveImpl,
  });
  if (handoff.status !== 'none') return handoff;

  const options = {
    staleMs,
    now,
    pid,
    randomUUIDImpl,
    isProcessAliveImpl,
  };
  const gate = acquireDirectory(`${lockPath}.acquire`, options);
  if (!gate) return { status: 'contended' };
  try {
    const lease = acquireMain(lockPath, options);
    return lease ? { status: 'acquired', lease } : { status: 'contended' };
  } finally {
    releaseSynchronousUpdateLease(gate);
  }
}

export function releaseSynchronousUpdateLease(lease) {
  if (!lease || lease.borrowed) return;
  try {
    unlinkSync(lease.leasePath);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  removeEmptyDirectory(lease.lockPath);
}
