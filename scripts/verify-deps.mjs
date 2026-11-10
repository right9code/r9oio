#!/usr/bin/env node
/**
 * Tau dependency verifier / repairer.
 *
 * The published package externalizes its runtime dependencies, so a broken
 * node_modules (interrupted update, EPERM cleanup on Windows, antivirus
 * locks...) crashes the CLI at runtime with "Cannot find module". This
 * script checks that every declared runtime dependency is actually present
 * and, when asked, repairs the tree by re-running `npm install` inside the
 * package root.
 *
 * It is intentionally dependency-free (node builtins only): it must run
 * precisely when node_modules is broken.
 *
 * Usage:
 *   node scripts/verify-deps.mjs            # verify, exit 1 if missing
 *   node scripts/verify-deps.mjs --repair   # verify, repair, re-verify
 *   node scripts/verify-deps.mjs --quiet    # no progress bar, summary only
 *   node scripts/verify-deps.mjs --json     # machine-readable result
 */

import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  acquireSynchronousUpdateLease,
  getGlobalUpdateLockPath,
  getManagedLocalUpdateLockPath,
  leaseEnvironment,
  releaseSynchronousUpdateLease,
} from './update-lock.mjs';

const __filename = fileURLToPath(import.meta.url);
const defaultPackageRoot = resolve(dirname(__filename), '..');

export const LIFECYCLE_MARKER_FILENAME = '.tau-lifecycle-complete.json';
export const LIFECYCLE_MARKER_SCHEMA = 1;
const TAU_PACKAGE_NAME = '@right9/oio';
const TAU_INSTALLER_SPEC = '@right9/oio-installer@latest';
const GLOBAL_UPDATE_LOCK_ENV = 'TAU_UPDATE_LOCK';
const LOCAL_UPDATE_LOCK_ENV = 'TAU_LOCAL_UPDATE_LOCK';
export const TAU_RUNTIME_ALLOW_SCRIPTS = Object.freeze([
  TAU_PACKAGE_NAME,
  '@whiskeysockets/baileys',
  'core-js',
  'fsevents',
  'node-pty',
  'protobufjs',
  'sharp',
]);

// A few declared dependencies intentionally have no CommonJS-resolvable root:
// one is import-only, one is type-only, and two expose only subpaths/binaries.
// Validate the actual runtime files Tau uses instead of falsely rejecting
// those legitimate package shapes. Every other dependency must resolve through
// Node's real package resolver, not merely contain a package.json file.
const EXPLICIT_DEPENDENCY_RUNTIME_FILES = Object.freeze({
  '@alcalzone/ansi-tokenize': ['build/index.js'],
  '@modelcontextprotocol/sdk': [
    'dist/esm/types.js',
    'dist/esm/server/index.js',
    'dist/esm/server/stdio.js',
    'dist/esm/server/auth/errors.js',
    'dist/esm/client/index.js',
    'dist/esm/client/sse.js',
    'dist/esm/client/stdio.js',
    'dist/esm/client/streamableHttp.js',
    'dist/esm/client/auth.js',
    'dist/esm/shared/auth.js',
    'dist/esm/shared/transport.js',
  ],
  'vscode-langservers-extracted': [
    'bin/vscode-html-language-server',
    'bin/vscode-css-language-server',
    'bin/vscode-json-language-server',
  ],
});
const MANIFEST_ONLY_DEPENDENCIES = new Set([
  // Imported only through TypeScript `import type`; no runtime entry exists.
  'type-fest',
]);
const EXACT_SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export function isExactVersion(value) {
  const match = EXACT_SEMVER_PATTERN.exec(value);
  if (!match) return false;
  const prerelease = match[4];
  if (!prerelease) return true;
  return prerelease
    .split('.')
    .every(
      identifier =>
        !/^\d+$/.test(identifier) ||
        identifier === '0' ||
        !identifier.startsWith('0'),
    );
}

function npmSupportsAllowScripts(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/.exec(version);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 11 || (major === 11 && minor >= 16);
}

function readPackageManifest(packageRoot) {
  return JSON.parse(
    readFileSync(join(packageRoot, 'package.json'), 'utf8').replace(/^\uFEFF/, ''),
  );
}

/** Return whether postinstall completed for this exact package version. */
export function getLifecycleMarkerStatus(packageRoot = defaultPackageRoot) {
  const manifest = readPackageManifest(packageRoot);
  const markerPath = join(packageRoot, LIFECYCLE_MARKER_FILENAME);
  const expected = {
    schema: LIFECYCLE_MARKER_SCHEMA,
    packageName: manifest.name,
    version: manifest.version,
  };

  if (!existsSync(markerPath)) {
    return { ok: false, reason: 'missing', markerPath, expected };
  }

  try {
    const actual = JSON.parse(readFileSync(markerPath, 'utf8'));
    const ok =
      actual?.schema === expected.schema &&
      actual?.packageName === expected.packageName &&
      actual?.version === expected.version;
    return {
      ok,
      reason: ok ? 'complete' : 'mismatch',
      markerPath,
      expected,
      actual,
    };
  } catch (error) {
    return {
      ok: false,
      reason: 'invalid',
      markerPath,
      expected,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Invalidate any previous successful lifecycle run before a reinstall starts.
 * Failure to remove the marker is fatal: otherwise a same-version reinstall
 * could fail while leaving stale proof that its postinstall completed.
 */
export function clearLifecycleCompletionMarker(
  packageRoot = defaultPackageRoot,
) {
  const markerPath = join(packageRoot, LIFECYCLE_MARKER_FILENAME);
  rmSync(markerPath, { force: true });
  return markerPath;
}

/**
 * Atomically publish the completion marker after postinstall finishes.
 * The root-level dotfile is intentionally outside package.json's files list,
 * so it can only be generated at the destination and is never packed.
 */
export function writeLifecycleCompletionMarker(
  packageRoot = defaultPackageRoot,
  opts = {},
) {
  const manifest = readPackageManifest(packageRoot);
  const markerPath = join(packageRoot, LIFECYCLE_MARKER_FILENAME);
  const temporaryPath = `${markerPath}.${process.pid}.${
    opts.nonce ?? randomUUID()
  }.tmp`;
  const marker = {
    schema: LIFECYCLE_MARKER_SCHEMA,
    packageName: manifest.name,
    version: manifest.version,
    completedAt: (opts.now ?? (() => new Date()))().toISOString(),
  };

  writeFileSync(temporaryPath, `${JSON.stringify(marker)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  });

  try {
    try {
      renameSync(temporaryPath, markerPath);
    } catch (error) {
      // POSIX replaces atomically. Windows can reject replacing an existing
      // file; keep an already-valid marker or replace only an invalid one.
      const existing = getLifecycleMarkerStatus(packageRoot);
      if (existing.ok) {
        rmSync(temporaryPath, { force: true });
        return markerPath;
      }
      rmSync(markerPath, { force: true });
      renameSync(temporaryPath, markerPath);
    }
  } finally {
    rmSync(temporaryPath, { force: true });
  }

  return markerPath;
}

/** Runtime dependencies the bundle resolves from node_modules at runtime. */
export function listRuntimeDeps(packageRoot) {
  const pkg = readPackageManifest(packageRoot);
  return Object.keys(pkg.dependencies ?? {}).sort();
}

/**
 * True if `dep` resolves from `packageRoot` the way Node's resolver would:
 * packageRoot/node_modules first, then each parent directory's node_modules
 * (covers global installs, local project installs, and the dev repo).
 */
function findDependencyManifest(packageRoot, dep) {
  let dir = resolve(packageRoot);
  for (;;) {
    const manifestPath = join(dir, 'node_modules', dep, 'package.json');
    if (existsSync(manifestPath)) return manifestPath;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function depResolves(packageRoot, dep, resolver) {
  const manifestPath = findDependencyManifest(packageRoot, dep);
  if (!manifestPath) return false;

  if (MANIFEST_ONLY_DEPENDENCIES.has(dep)) return true;

  const explicitFiles = EXPLICIT_DEPENDENCY_RUNTIME_FILES[dep];
  if (explicitFiles) {
    const dependencyRoot = dirname(manifestPath);
    return explicitFiles.every(relativePath =>
      existsSync(join(dependencyRoot, ...relativePath.split('/'))),
    );
  }

  try {
    resolver.resolve(dep);
    return true;
  } catch {
    return false;
  }
}

/** Names of declared runtime deps that do NOT resolve. Fast (<10ms). */
export function findMissingDeps(packageRoot = defaultPackageRoot) {
  const resolver = createRequire(join(resolve(packageRoot), 'package.json'));
  return listRuntimeDeps(packageRoot).filter(
    dep => !depResolves(packageRoot, dep, resolver),
  );
}

/** One-line progress bar on stderr (TTY only — silent when piped). */
function drawProgress(current, total, label) {
  if (!process.stderr.isTTY) return;
  const width = 24;
  const filled = Math.round((current / total) * width);
  const bar = '█'.repeat(filled) + '░'.repeat(width - filled);
  const line = `\r[tau] [${bar}] ${current}/${total} ${label}`;
  process.stderr.write(line.padEnd(Math.min(79, line.length + 20)));
  if (current === total) process.stderr.write('\n');
}

/**
 * Verify all runtime deps with a visible progress bar.
 * Returns { total, missing } where missing is an array of package names.
 */
export function verifyDeps(packageRoot = defaultPackageRoot, opts = {}) {
  const deps = listRuntimeDeps(packageRoot);
  const resolver = createRequire(join(resolve(packageRoot), 'package.json'));
  const missing = [];
  deps.forEach((dep, i) => {
    if (!depResolves(packageRoot, dep, resolver)) missing.push(dep);
    if (!opts.quiet) drawProgress(i + 1, deps.length, dep);
  });
  return { total: deps.length, missing };
}

const OVERRIDDEN_NPM_CONFIGS = new Set([
  'npm_config_allow_scripts',
  'npm_config_ignore_scripts',
  'npm_config_dangerously_allow_all_scripts',
  'npm_config_strict_allow_scripts',
  'npm_config_dry_run',
  'npm_config_global',
  'npm_config_location',
  'npm_config_package_lock_only',
  'npm_config_omit',
  'npm_config_include',
  'npm_config_optional',
  'npm_config_production',
  'npm_config_bin_links',
]);

/** Remove inherited npm switches that can silently weaken or redirect repair. */
export function createRepairEnvironment(source = process.env, additions = {}) {
  const env = { ...source, ...additions };
  for (const key of Object.keys(env)) {
    if (OVERRIDDEN_NPM_CONFIGS.has(key.toLowerCase().replaceAll('-', '_'))) {
      delete env[key];
    }
  }
  return env;
}

function getNpmInvocation(env, opts = {}) {
  const npmExecPath = env.npm_execpath?.trim();
  if (npmExecPath && /\.[cm]?js$/i.test(npmExecPath)) {
    return {
      command: opts.nodeExecutable ?? process.execPath,
      prefixArguments: [npmExecPath],
      shell: false,
    };
  }
  return {
    command: (opts.platform ?? process.platform) === 'win32' ? 'npm.cmd' : 'npm',
    prefixArguments: [],
    shell: (opts.platform ?? process.platform) === 'win32',
  };
}

function comparablePath(path, platform = process.platform) {
  let normalized = resolve(path);
  try {
    normalized = realpathSync.native(normalized);
  } catch {
    // A path can disappear while npm atomically replaces the package. The
    // resolved lexical path is still sufficient for the containment check.
  }
  return platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isSamePath(left, right, platform = process.platform) {
  return comparablePath(left, platform) === comparablePath(right, platform);
}

/**
 * Classify the tree before any repair can mutate global state. A missing
 * marker is ignored only for a source checkout. A recognized managed-local
 * tree is repaired in place; every other non-global tree fails closed and is
 * never redirected into a global installation.
 */
export function classifyInstallation(packageRoot = defaultPackageRoot, opts = {}) {
  const manifest = readPackageManifest(packageRoot);
  const platform = opts.platform ?? process.platform;
  const sourceCheckout =
    existsSync(join(packageRoot, 'src')) &&
    (existsSync(join(packageRoot, '.git')) ||
      existsSync(join(packageRoot, 'package-lock.json')));
  if (sourceCheckout) return { kind: 'development' };

  const env = opts.env ?? process.env;
  const home = opts.homeDirectory ?? homedir();
  const configHomes = [join(home, '.claude')];
  if (env.CLAUDE_CONFIG_DIR) configHomes.push(resolve(env.CLAUDE_CONFIG_DIR));
  for (const configHome of configHomes) {
    const expectedLocalRoot = join(
      configHome,
      'local',
      'node_modules',
      ...String(manifest.name).split('/'),
    );
    if (isSamePath(packageRoot, expectedLocalRoot, platform)) {
      return { kind: 'managed-local', projectRoot: join(configHome, 'local') };
    }
  }

  const childEnv = createRepairEnvironment(env);
  const invocation = getNpmInvocation(childEnv, opts);
  const spawnSyncImpl = opts.spawnSyncImpl ?? spawnSync;
  const result = spawnSyncImpl(
    invocation.command,
    [...invocation.prefixArguments, 'root', '--global'],
    {
      cwd: home,
      env: childEnv,
      stdio: 'pipe',
      shell: invocation.shell,
      windowsHide: true,
      timeout: opts.probeTimeout ?? 30_000,
    },
  );
  const globalNodeModules =
    result.status === 0 ? String(result.stdout ?? '').trim() : '';
  if (globalNodeModules) {
    const expectedGlobalRoot = join(
      globalNodeModules,
      ...String(manifest.name).split('/'),
    );
    if (isSamePath(packageRoot, expectedGlobalRoot, platform)) {
      return { kind: 'global', globalNodeModules };
    }
  }

  return { kind: 'installed-other' };
}

function acquireRepairLease(installation, childEnv, opts = {}) {
  let lockPath;
  let envPrefix;
  if (installation?.kind === 'global') {
    lockPath = getGlobalUpdateLockPath(
      childEnv,
      opts.homeDirectory ?? homedir(),
    );
    envPrefix = GLOBAL_UPDATE_LOCK_ENV;
  } else if (installation?.kind === 'managed-local') {
    lockPath = getManagedLocalUpdateLockPath(installation.projectRoot);
    envPrefix = LOCAL_UPDATE_LOCK_ENV;
  } else {
    return { status: 'unlocked', lease: null };
  }

  const result = acquireSynchronousUpdateLease({
    lockPath,
    env: childEnv,
    envPrefix,
    platform: opts.platform ?? process.platform,
    ...(opts.updateLockStaleMs === undefined
      ? {}
      : { staleMs: opts.updateLockStaleMs }),
    ...(opts.updateLockNow === undefined ? {} : { now: opts.updateLockNow }),
    ...(opts.updateLockPid === undefined ? {} : { pid: opts.updateLockPid }),
    ...(opts.updateLockRandomUUID === undefined
      ? {}
      : { randomUUIDImpl: opts.updateLockRandomUUID }),
    ...(opts.isProcessAliveImpl === undefined
      ? {}
      : { isProcessAliveImpl: opts.isProcessAliveImpl }),
  });
  if (result.status === 'acquired' || result.status === 'borrowed') {
    Object.assign(childEnv, leaseEnvironment(result.lease, envPrefix));
  }
  return result;
}

function releaseRepairLease(result) {
  if (result?.lease) releaseSynchronousUpdateLease(result.lease);
}

/** Reinstall this exact global Tau version through the reviewed installer. */
export function repairGlobalLifecycle(packageRoot = defaultPackageRoot, opts = {}) {
  const manifest = readPackageManifest(packageRoot);
  if (manifest.name !== TAU_PACKAGE_NAME || !isExactVersion(manifest.version)) {
    return false;
  }

  const sourceEnv = opts.env ?? process.env;
  if (sourceEnv.TAU_LIFECYCLE_BRIDGE_REPAIR === '1') return false;
  const childEnv = createRepairEnvironment(sourceEnv, {
    TAU_LIFECYCLE_BRIDGE_REPAIR: '1',
  });
  const invocation = getNpmInvocation(childEnv, opts);
  const spawnSyncImpl = opts.spawnSyncImpl ?? spawnSync;
  const interactive = opts.interactive ?? process.stderr.isTTY;
  const args = [
    ...invocation.prefixArguments,
    'exec',
    '--yes',
    '--prefer-online',
    '--no-fund',
    '--no-audit',
    '--ignore-scripts=false',
    '--dry-run=false',
    '--global=false',
    '--package-lock-only=false',
    '--bin-links=true',
    `--package=${TAU_INSTALLER_SPEC}`,
    '--',
    'oio-installer',
    '--oio-version',
    manifest.version,
  ];
  const result = spawnSyncImpl(invocation.command, args, {
    cwd: opts.homeDirectory ?? homedir(),
    env: childEnv,
    stdio: interactive ? 'inherit' : 'pipe',
    shell: invocation.shell,
    windowsHide: true,
  });

  return result.status === 0;
}

function getReviewedLifecyclePolicy(manifest) {
  if (
    !TAU_RUNTIME_ALLOW_SCRIPTS.every(
      name => manifest.allowScripts?.[name] === true,
    )
  ) {
    return null;
  }
  return Object.fromEntries(
    TAU_RUNTIME_ALLOW_SCRIPTS.map(name => [name, true]),
  );
}

function replaceFileAtomically(filePath, contents, opts = {}) {
  const nonce = opts.nonce ?? randomUUID();
  const temporaryPath = `${filePath}.${process.pid}.${nonce}.tmp`;
  const backupPath = `${filePath}.${process.pid}.${nonce}.bak`;
  let backupCreated = false;
  let replacementComplete = false;

  writeFileSync(temporaryPath, contents, { encoding: 'utf8', flag: 'wx' });
  try {
    try {
      renameSync(temporaryPath, filePath);
      replacementComplete = true;
    } catch (initialError) {
      if (!existsSync(filePath)) throw initialError;

      // Windows may not replace an existing file with rename. Move the old
      // manifest aside, publish the complete replacement, then remove backup.
      renameSync(filePath, backupPath);
      backupCreated = true;
      try {
        renameSync(temporaryPath, filePath);
        replacementComplete = true;
      } catch (replacementError) {
        try {
          renameSync(backupPath, filePath);
          backupCreated = false;
        } catch {
          // Preserve the backup for manual recovery if restoration is blocked.
        }
        throw replacementError;
      }
    }
  } finally {
    rmSync(temporaryPath, { force: true });
    if (replacementComplete && backupCreated) {
      rmSync(backupPath, { force: true });
    }
  }
}

/**
 * Repair an npm-managed ~/.claude/local installation without creating or
 * changing a global installation. Old Tau versions did not seed npm 12's
 * project policy, so migrate the reviewed policy before the exact reinstall.
 */
export function repairManagedLocalLifecycle(
  packageRoot = defaultPackageRoot,
  installation,
  opts = {},
) {
  const manifest = readPackageManifest(packageRoot);
  if (manifest.name !== TAU_PACKAGE_NAME || !isExactVersion(manifest.version)) {
    return false;
  }

  const projectRoot = installation?.projectRoot;
  if (!projectRoot || installation.kind !== 'managed-local') return false;

  const sourceEnv = opts.env ?? process.env;
  if (sourceEnv.TAU_LIFECYCLE_BRIDGE_REPAIR === '1') return false;
  const childEnv = createRepairEnvironment(sourceEnv, {
    TAU_LIFECYCLE_BRIDGE_REPAIR: '1',
  });

  const policy = getReviewedLifecyclePolicy(manifest);
  if (!policy) return false;

  const projectManifestPath = join(projectRoot, 'package.json');
  let projectManifest;
  try {
    projectManifest = JSON.parse(
      readFileSync(projectManifestPath, 'utf8').replace(/^\uFEFF/, ''),
    );
  } catch {
    return false;
  }
  if (projectManifest.name !== 'tau-local' || projectManifest.private !== true) {
    return false;
  }

  const repairLease = acquireRepairLease(installation, childEnv, opts);
  if (
    repairLease.status !== 'acquired' &&
    repairLease.status !== 'borrowed'
  ) {
    return false;
  }

  try {

    // This directory is created and owned by Tau's local installer. Keep the
    // approvals exact so unrelated packages cannot retain historical grants.
    if (JSON.stringify(projectManifest.allowScripts) !== JSON.stringify(policy)) {
      replaceFileAtomically(
        projectManifestPath,
        `${JSON.stringify({ ...projectManifest, allowScripts: policy }, null, 2)}\n`,
      );
    }

    const invocation = getNpmInvocation(childEnv, opts);
    const spawnSyncImpl = opts.spawnSyncImpl ?? spawnSync;
    const commonOptions = {
      cwd: projectRoot,
      env: childEnv,
      shell: invocation.shell,
      windowsHide: true,
    };
    const versionResult = spawnSyncImpl(
      invocation.command,
      [...invocation.prefixArguments, '--version'],
      { ...commonOptions, stdio: 'pipe' },
    );
    const npmVersion =
      versionResult.status === 0 ? String(versionResult.stdout ?? '').trim() : '';
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(npmVersion)) {
      return false;
    }

    const args = [
    ...invocation.prefixArguments,
    'install',
    `${TAU_PACKAGE_NAME}@${manifest.version}`,
    '--global=false',
    '--ignore-scripts=false',
    '--dry-run=false',
    '--package-lock-only=false',
    '--bin-links=true',
    '--include=optional',
    ...(npmSupportsAllowScripts(npmVersion)
      ? [
          '--dangerously-allow-all-scripts=false',
          '--strict-allow-scripts=true',
        ]
      : []),
    '--no-audit',
    '--no-fund',
    ];
    const interactive = opts.interactive ?? process.stderr.isTTY;
    let result;
    try {
      result = spawnSyncImpl(invocation.command, args, {
        ...commonOptions,
        stdio: interactive ? 'inherit' : 'pipe',
      });
    } finally {
      // A same-version install can run Tau's postinstall while leaving an
      // already-present scripted dependency unbuilt. Discard that preliminary
      // marker so only the ordered dependency + Tau rebuild below can certify.
      clearLifecycleCompletionMarker(packageRoot);
    }
    if (result.status !== 0) return false;

    const rebuildBase = [
    ...invocation.prefixArguments,
    'rebuild',
    '--global=false',
    '--ignore-scripts=false',
    '--dry-run=false',
    '--package-lock-only=false',
    '--bin-links=true',
    '--include=optional',
    ...(npmSupportsAllowScripts(npmVersion)
      ? [
          '--dangerously-allow-all-scripts=false',
          '--strict-allow-scripts=true',
        ]
      : []),
    '--no-audit',
    '--no-fund',
    ];
    const lifecycleDependencies = TAU_RUNTIME_ALLOW_SCRIPTS.filter(
      name => name !== TAU_PACKAGE_NAME,
    );
    const dependencyRebuild = spawnSyncImpl(
      invocation.command,
      [...rebuildBase, ...lifecycleDependencies],
      {
        ...commonOptions,
        stdio: interactive ? 'inherit' : 'pipe',
      },
    );
    if (dependencyRebuild.status !== 0) return false;

  // Rebuild Tau last. Its postinstall writes the completion marker only after
  // the reviewed dependency lifecycles above have completed successfully.
    const tauRebuild = spawnSyncImpl(
      invocation.command,
      [...rebuildBase, TAU_PACKAGE_NAME],
      {
        ...commonOptions,
        stdio: interactive ? 'inherit' : 'pipe',
      },
    );
    return tauRebuild.status === 0;
  } finally {
    releaseRepairLease(repairLease);
  }
}

/**
 * Repair the dependency tree by running `npm install` inside packageRoot.
 * Interactive mode inherits stdio so npm's own progress bar is visible.
 * Returns true if npm exited 0.
 */
export function repairDeps(packageRoot = defaultPackageRoot, opts = {}) {
  const interactive = opts.interactive ?? process.stderr.isTTY;
  const env = createRepairEnvironment(opts.env ?? process.env, {
    // The install re-triggers our own postinstall; keep it from recursing
    // into another verify/repair cycle or slow optional steps.
    TAU_REPAIR: '1',
    TAU_SKIP_OLLAMA_PREPULL: '1',
    TAU_SKIP_NATIVE_TOOLS_POSTINSTALL: '1',
  });
  const spawnSyncImpl = opts.spawnSyncImpl ?? spawnSync;
  const installation = opts.installation ?? classifyInstallation(packageRoot, opts);
  const repairLease = acquireRepairLease(installation, env, opts);
  if (
    repairLease.status !== 'unlocked' &&
    repairLease.status !== 'acquired' &&
    repairLease.status !== 'borrowed'
  ) {
    return false;
  }

  try {

    // Prefer the exact npm that is driving the current lifecycle when
    // available (postinstall), otherwise the npm on PATH. `.cmd` shims need
    // shell:true on Windows with modern Node.
    const npmExecPath = env.npm_execpath;
    const useNpmJs = npmExecPath && /\.[cm]?js$/.test(npmExecPath);
    const platform = opts.platform ?? process.platform;
    const nodeExecutable = opts.nodeExecutable ?? process.execPath;
    const spawnNpm = args =>
      useNpmJs
        ? spawnSyncImpl(nodeExecutable, [npmExecPath, ...args], {
            cwd: packageRoot,
            env,
            stdio: interactive ? 'inherit' : 'pipe',
          })
        : spawnSyncImpl(platform === 'win32' ? 'npm.cmd' : 'npm', args, {
            cwd: packageRoot,
            env,
            stdio: interactive ? 'inherit' : 'pipe',
            shell: platform === 'win32',
          });

    const versionResult = useNpmJs
      ? spawnSyncImpl(nodeExecutable, [npmExecPath, '--version'], {
          cwd: packageRoot,
          env,
          stdio: 'pipe',
        })
      : spawnSyncImpl(platform === 'win32' ? 'npm.cmd' : 'npm', ['--version'], {
          cwd: packageRoot,
          env,
          stdio: 'pipe',
          shell: platform === 'win32',
        });

    const npmVersion = versionResult.status === 0
      ? String(versionResult.stdout).trim()
      : '';
    const supportsAllowScripts = npmSupportsAllowScripts(npmVersion);
    const args = [
      'install',
      '--global=false',
      '--omit=dev',
      '--include=optional',
      '--ignore-scripts=false',
      '--dry-run=false',
      '--package-lock-only=false',
      '--bin-links=true',
      ...(supportsAllowScripts
        ? [
            '--dangerously-allow-all-scripts=false',
            '--strict-allow-scripts=true',
          ]
        : []),
      '--no-audit',
      '--no-fund',
      ...(interactive ? [] : ['--loglevel=error', '--progress=false']),
    ];
    const result = spawnNpm(args);

    return result.status === 0;
  } finally {
    releaseRepairLease(repairLease);
  }
}

/** Human-readable manual recovery instructions. */
export function manualFixInstructions(packageName) {
  return [
    `Tau's installation is incomplete and automatic repair did not finish.`,
    `For a managed local install (~/.claude/local), retry in place with:`,
    ``,
    `  tau update`,
    ``,
    `For an npm-global install, run:`,
    ``,
    `  npx -y @right9/oio-installer@latest`,
    ``,
    `If npm reports EEXIST on a 'tau' or 'claudex' file, delete that file`,
    `and re-run the install. If it reports EPERM on Windows, close every`,
    `running tau/claudex session first, then retry.`,
  ].join('\n');
}

/**
 * Full check-and-heal pass: verify → repair if needed → re-verify.
 * Returns true when the tree is complete at the end.
 */
export function ensureDeps(packageRoot = defaultPackageRoot, opts = {}) {
  const log = opts.quiet ? () => {} : msg => process.stderr.write(`${msg}\n`);
  const { total, missing } = verifyDeps(packageRoot, opts);
  let markerStatus = opts.skipLifecycleMarker
    ? { ok: true, reason: 'skipped' }
    : getLifecycleMarkerStatus(packageRoot);
  let installation = null;

  if (!markerStatus.ok) {
    installation = classifyInstallation(packageRoot, opts);
    if (installation.kind === 'development') {
      // Source checkouts are built and run directly, not by npm postinstall.
      markerStatus = { ok: true, reason: 'development' };
    }
  }

  if (missing.length === 0 && markerStatus.ok) {
    log(`[tau] ✓ ${total}/${total} runtime dependencies verified`);
    return true;
  }

  if (missing.length > 0) {
    log(
      `[tau] ${missing.length} of ${total} runtime dependencies are missing:` +
        ` ${missing.slice(0, 8).join(', ')}${missing.length > 8 ? ', ...' : ''}`,
    );
  }
  if (!markerStatus.ok) {
    log(
      `[tau] Lifecycle installation is incomplete (${markerStatus.reason}); ` +
        'the exact Tau version must be reinstalled with reviewed scripts.',
    );
  }

  if (!opts.repair) return false;

  if (!markerStatus.ok) {
    let repaired = false;
    if (installation?.kind === 'global') {
      log(`[tau] Repairing lifecycle installation for this exact Tau version...`);
      repaired = repairGlobalLifecycle(packageRoot, opts);
    } else if (installation?.kind === 'managed-local') {
      log(
        `[tau] Repairing the managed local lifecycle for this exact Tau version...`,
      );
      repaired = repairManagedLocalLifecycle(packageRoot, installation, opts);
    } else {
      log(
        `[tau] Refusing global lifecycle repair for ${
          installation?.kind ?? 'an unclassified installation'
        }.`,
      );
      return false;
    }

    if (!repaired) {
      log('[tau] Exact-version lifecycle repair failed.');
      return false;
    }

    const afterLifecycleDeps = verifyDeps(packageRoot, { quiet: true });
    const afterLifecycleMarker = getLifecycleMarkerStatus(packageRoot);
    if (
      afterLifecycleDeps.missing.length === 0 &&
      afterLifecycleMarker.ok
    ) {
      log(
        `[tau] ✓ Lifecycle repair complete — ${total}/${total} dependencies verified`,
      );
      return true;
    }

    log(
      `[tau] Lifecycle repair incomplete — marker: ${afterLifecycleMarker.reason}; ` +
        `missing dependencies: ${afterLifecycleDeps.missing.join(', ') || 'none'}`,
    );
    return false;
  }

  log(`[tau] Repairing installation (npm install in ${packageRoot})...`);
  if (!repairDeps(packageRoot, opts)) {
    log('[tau] npm dependency repair failed.');
    return false;
  }

  const after = verifyDeps(packageRoot, { quiet: true });
  const afterMarker = opts.skipLifecycleMarker
    ? { ok: true }
    : getLifecycleMarkerStatus(packageRoot);
  if (after.missing.length === 0 && afterMarker.ok) {
    log(`[tau] ✓ Repair complete — ${total}/${total} dependencies verified`);
    return true;
  }
  log(
    `[tau] Repair incomplete — still missing: ${after.missing.join(', ') || 'none'}; ` +
      `lifecycle marker: ${afterMarker.ok ? 'complete' : afterMarker.reason}`,
  );
  return false;
}

// ─── CLI entrypoint ────────────────────────────────────────────────

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === __filename;

if (invokedDirectly) {
  const flags = new Set(process.argv.slice(2));
  const quiet = flags.has('--quiet') || flags.has('--json');
  const repair = flags.has('--repair');

  let ok = false;
  try {
    if (flags.has('--json')) {
      const { total } = verifyDeps(defaultPackageRoot, { quiet: true });
      ok = ensureDeps(defaultPackageRoot, { repair, quiet: true });
      const after = verifyDeps(defaultPackageRoot, { quiet: true });
      process.stdout.write(
        `${JSON.stringify({ total, missing: after.missing, ok })}\n`,
      );
    } else {
      ok = ensureDeps(defaultPackageRoot, { repair, quiet });
      if (!ok && repair) {
        process.stderr.write(`\n${manualFixInstructions(JSON.parse(readFileSync(join(defaultPackageRoot, 'package.json'), 'utf8')).name)}\n`);
      }
    }
  } catch (err) {
    process.stderr.write(`[tau] verify-deps failed: ${err?.message ?? err}\n`);
    ok = false;
  }
  process.exit(ok ? 0 : 1);
}
