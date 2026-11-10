#!/usr/bin/env node

/**
 * Build Tau's publish-only production shrinkwrap from the tested development
 * package-lock. The canonical artifact lives under release/ because npm gives a
 * root npm-shrinkwrap.json precedence over package-lock.json; keeping the
 * production-only file at the repository root would break normal `npm ci`
 * (package.json intentionally still declares development dependencies).
 *
 * The canonical file pins the production dependency graph. Its root package
 * version is materialized from package.json when checking and staging, so a
 * version-only release does not require regenerating an unchanged graph.
 * `npm pack` / `npm publish` stage that materialized file at the package root
 * in prepack and remove it in postpack, so downstream installs still receive
 * the standard root npm-shrinkwrap.json.
 */

import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const releaseDirectory = dirname(fileURLToPath(import.meta.url));
export const REPOSITORY_ROOT = dirname(releaseDirectory);
export const SOURCE_LOCK_PATH = join(REPOSITORY_ROOT, 'package-lock.json');
export const CANONICAL_SHRINKWRAP_PATH = join(
  releaseDirectory,
  'npm-shrinkwrap.production.json',
);
export const STAGED_SHRINKWRAP_PATH = join(
  REPOSITORY_ROOT,
  'npm-shrinkwrap.json',
);

const OVERRIDDEN_NPM_CONFIGS = new Set([
  'npm_config_dry_run',
  'npm_config_global',
  'npm_config_ignore_scripts',
  'npm_config_include',
  'npm_config_location',
  'npm_config_omit',
  'npm_config_optional',
  'npm_config_package_lock',
  'npm_config_package_lock_only',
  'npm_config_production',
  'npm_config_workspaces',
]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function stableObject(value) {
  if (Array.isArray(value)) return value.map(stableObject);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map(key => [key, stableObject(value[key])]),
  );
}

function serialize(value) {
  return `${JSON.stringify(stableObject(value), null, 2)}\n`;
}

function sameJson(left, right) {
  return serialize(left) === serialize(right);
}

function packageLockPath(packageName) {
  return `node_modules/${packageName}`;
}

export function createProductionManifest(manifest) {
  const production = clone(manifest);
  delete production.devDependencies;
  delete production.workspaces;
  return production;
}

export function createStagedSourceLock(sourceLock) {
  const staged = clone(sourceLock);
  const root = staged.packages?.[''];
  if (!root) throw new Error('package-lock.json has no root package entry.');
  delete root.devDependencies;
  delete root.workspaces;

  // npm can retain a removed workspace as an extraneous packages/* entry.
  // Remove workspace roots and links before asking npm to recalculate flags.
  for (const [path, metadata] of Object.entries(staged.packages)) {
    if (!path) continue;
    if (!path.startsWith('node_modules/') || metadata?.link === true) {
      delete staged.packages[path];
    }
  }
  return staged;
}

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

/** Apply only the current root package version to a canonical graph snapshot. */
export function materializeCanonicalShrinkwrap(canonical, manifest) {
  const materialized = clone(canonical);
  const root = materialized?.packages?.[''];
  invariant(root, 'Shrinkwrap has no root package entry.');
  invariant(
    materialized.version === root.version,
    'Shrinkwrap root package version does not match its top-level version.',
  );
  materialized.version = manifest.version;
  root.version = manifest.version;
  return materialized;
}

/** Validate that a candidate is production-only and pins the tested graph. */
export function verifyProductionShrinkwrap(
  candidate,
  manifest,
  sourceLock,
) {
  invariant(sourceLock.name === manifest.name, 'package-lock.json package name is stale.');
  invariant(
    sourceLock.version === manifest.version,
    'package-lock.json package version is stale.',
  );
  const sourceRoot = sourceLock.packages?.[''];
  invariant(sourceRoot, 'package-lock.json has no root package entry.');
  invariant(
    sourceRoot.name === manifest.name,
    'package-lock.json root package name is stale.',
  );
  invariant(
    sourceRoot.version === manifest.version,
    'package-lock.json root package version is stale.',
  );

  invariant(candidate?.lockfileVersion === 3, 'Shrinkwrap must use lockfileVersion 3.');
  invariant(candidate.name === manifest.name, 'Shrinkwrap package name is stale.');
  invariant(candidate.version === manifest.version, 'Shrinkwrap package version is stale.');

  const root = candidate.packages?.[''];
  invariant(root, 'Shrinkwrap has no root package entry.');
  invariant(root.name === manifest.name, 'Shrinkwrap root package name is stale.');
  invariant(root.version === manifest.version, 'Shrinkwrap root package version is stale.');
  invariant(!root.devDependencies, 'Shrinkwrap root must not contain devDependencies.');
  invariant(!root.workspaces, 'Shrinkwrap root must not contain workspaces.');
  invariant(
    sameJson(root.dependencies ?? {}, manifest.dependencies ?? {}),
    'Shrinkwrap root dependencies do not match package.json.',
  );
  invariant(
    sameJson(root.optionalDependencies ?? {}, manifest.optionalDependencies ?? {}),
    'Shrinkwrap root optionalDependencies do not match package.json.',
  );

  const sourcePackages = sourceLock.packages ?? {};
  const candidatePackages = candidate.packages ?? {};
  for (const [path, metadata] of Object.entries(candidatePackages)) {
    if (!path) continue;
    invariant(
      path.startsWith('node_modules/'),
      `Shrinkwrap contains a workspace/non-package entry: ${path}`,
    );
    invariant(metadata.dev !== true, `Shrinkwrap contains a dev entry: ${path}`);
    invariant(
      metadata.devOptional !== true,
      `Shrinkwrap contains a devOptional entry: ${path}`,
    );
    invariant(metadata.link !== true, `Shrinkwrap contains a link entry: ${path}`);
    invariant(
      metadata.extraneous !== true,
      `Shrinkwrap contains an extraneous entry: ${path}`,
    );

    const tested = sourcePackages[path];
    invariant(tested, `Shrinkwrap added an untested package path: ${path}`);
    for (const field of ['version', 'resolved', 'integrity']) {
      invariant(
        metadata[field] === tested[field],
        `Shrinkwrap changed tested ${field} for ${path}.`,
      );
    }
  }

  invariant(
    !candidatePackages['packages/tau-installer'] &&
      !candidatePackages['node_modules/@right9/oio-installer'],
    'Shrinkwrap must not contain the oio-installer workspace.',
  );

  // Keep every production optional entry from the cross-platform development
  // lock, including fsevents, sharp/libvips variants, and Tau platform bridges.
  for (const [path, metadata] of Object.entries(sourcePackages)) {
    if (!path || metadata.dev === true || metadata.optional !== true) continue;
    invariant(
      candidatePackages[path],
      `Shrinkwrap dropped tested optional package ${path}.`,
    );
  }
  for (const packageName of Object.keys(manifest.optionalDependencies ?? {})) {
    invariant(
      candidatePackages[packageLockPath(packageName)],
      `Shrinkwrap dropped direct optional dependency ${packageName}.`,
    );
  }

  return true;
}

/** Verify a canonical graph after applying version-only release metadata. */
export function verifyCanonicalShrinkwrap(
  canonical,
  generated,
  manifest,
  sourceLock,
) {
  const materialized = materializeCanonicalShrinkwrap(canonical, manifest);
  verifyProductionShrinkwrap(materialized, manifest, sourceLock);
  invariant(
    sameJson(materialized, generated),
    'Production shrinkwrap is stale. Run `npm run shrinkwrap:generate`.',
  );
  return true;
}

function createNpmEnvironment(source = process.env) {
  const env = { ...source };
  for (const key of Object.keys(env)) {
    if (OVERRIDDEN_NPM_CONFIGS.has(key.toLowerCase().replaceAll('-', '_'))) {
      delete env[key];
    }
  }
  return env;
}

function npmInvocation(env, options = {}) {
  const npmExecPath = options.npmExecPath ?? env.npm_execpath;
  if (npmExecPath && /\.[cm]?js$/i.test(npmExecPath)) {
    return {
      command:
        options.nodeExecPath ?? env.npm_node_execpath ?? process.execPath,
      prefixArguments: [npmExecPath],
      shell: false,
    };
  }
  const platform = options.platform ?? process.platform;
  return {
    command: platform === 'win32' ? 'npm.cmd' : 'npm',
    prefixArguments: [],
    shell: platform === 'win32',
  };
}

export function generateProductionShrinkwrap(options = {}) {
  const manifest = options.manifest ?? JSON.parse(
    readFileSync(join(REPOSITORY_ROOT, 'package.json'), 'utf8'),
  );
  const sourceLock = options.sourceLock ?? JSON.parse(
    readFileSync(SOURCE_LOCK_PATH, 'utf8'),
  );
  const stagingDirectory = mkdtempSync(
    join(options.temporaryDirectory ?? tmpdir(), 'tau-production-lock-'),
  );

  try {
    writeFileSync(
      join(stagingDirectory, 'package.json'),
      serialize(createProductionManifest(manifest)),
    );
    writeFileSync(
      join(stagingDirectory, 'package-lock.json'),
      serialize(createStagedSourceLock(sourceLock)),
    );

    const env = createNpmEnvironment(options.env ?? process.env);
    const invocation = npmInvocation(env, options);
    const spawnSyncImpl = options.spawnSyncImpl ?? spawnSync;
    const result = spawnSyncImpl(
      invocation.command,
      [
        ...invocation.prefixArguments,
        'prune',
        '--package-lock-only',
        '--ignore-scripts',
        '--omit=dev',
        '--include=optional',
        '--workspaces=false',
        '--no-audit',
        '--no-fund',
        '--loglevel=error',
      ],
      {
        cwd: stagingDirectory,
        env,
        encoding: 'utf8',
        shell: invocation.shell,
        windowsHide: true,
        timeout: options.timeout ?? 120_000,
      },
    );
    if (result.status !== 0) {
      const details = [result.error?.message, result.stderr, result.stdout]
        .filter(Boolean)
        .join('\n')
        .trim();
      throw new Error(`Unable to generate production shrinkwrap.${details ? `\n${details}` : ''}`);
    }

    const candidate = JSON.parse(
      readFileSync(join(stagingDirectory, 'package-lock.json'), 'utf8'),
    );
    verifyProductionShrinkwrap(candidate, manifest, sourceLock);
    return candidate;
  } finally {
    rmSync(stagingDirectory, { recursive: true, force: true });
  }
}

function replaceFileAtomically(path, contents) {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporaryPath, contents, { encoding: 'utf8', flag: 'wx' });
  try {
    try {
      renameSync(temporaryPath, path);
    } catch (error) {
      if (!existsSync(path)) throw error;
      rmSync(path, { force: true });
      renameSync(temporaryPath, path);
    }
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

function readReleaseInputs() {
  return {
    manifest: JSON.parse(readFileSync(join(REPOSITORY_ROOT, 'package.json'), 'utf8')),
    sourceLock: JSON.parse(readFileSync(SOURCE_LOCK_PATH, 'utf8')),
  };
}

export function checkCanonicalShrinkwrap(options = {}) {
  const { manifest, sourceLock } = readReleaseInputs();
  const canonical = JSON.parse(
    readFileSync(CANONICAL_SHRINKWRAP_PATH, 'utf8'),
  );
  const generated = generateProductionShrinkwrap({ ...options, manifest, sourceLock });
  return verifyCanonicalShrinkwrap(canonical, generated, manifest, sourceLock);
}

export function stageCanonicalShrinkwrap() {
  const { manifest, sourceLock } = readReleaseInputs();
  const canonical = JSON.parse(
    readFileSync(CANONICAL_SHRINKWRAP_PATH, 'utf8'),
  );
  const materialized = materializeCanonicalShrinkwrap(canonical, manifest);
  verifyProductionShrinkwrap(materialized, manifest, sourceLock);
  replaceFileAtomically(STAGED_SHRINKWRAP_PATH, serialize(materialized));
}

export function cleanStagedShrinkwrap() {
  if (!existsSync(STAGED_SHRINKWRAP_PATH)) return;
  const { manifest } = readReleaseInputs();
  const staged = readFileSync(STAGED_SHRINKWRAP_PATH, 'utf8');
  const canonical = JSON.parse(
    readFileSync(CANONICAL_SHRINKWRAP_PATH, 'utf8'),
  );
  const expected = serialize(materializeCanonicalShrinkwrap(canonical, manifest));
  if (staged !== expected) {
    throw new Error(
      'Refusing to remove npm-shrinkwrap.json because it differs from the staged production lock.',
    );
  }
  rmSync(STAGED_SHRINKWRAP_PATH, { force: true });
}

function writeCanonicalShrinkwrap(options = {}) {
  const candidate = generateProductionShrinkwrap(options);
  replaceFileAtomically(CANONICAL_SHRINKWRAP_PATH, serialize(candidate));
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const mode = process.argv[2] ?? '--write';
  try {
    if (mode === '--write') writeCanonicalShrinkwrap();
    else if (mode === '--check') checkCanonicalShrinkwrap();
    else if (mode === '--stage') stageCanonicalShrinkwrap();
    else if (mode === '--clean') cleanStagedShrinkwrap();
    else throw new Error(`Unknown production shrinkwrap mode: ${mode}`);
    // prepack/postpack must stay silent so `npm pack --json` remains valid JSON.
    if (mode === '--write' || mode === '--check') {
      process.stdout.write(`[tau] Production shrinkwrap ${mode.slice(2)} complete.\n`);
    }
  } catch (error) {
    process.stderr.write(
      `[tau] Production shrinkwrap failed: ${error instanceof Error ? error.message : error}\n`,
    );
    process.exitCode = 1;
  }
}
