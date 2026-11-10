#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const INSTALLER_PACKAGE = '@right9/oio-installer';
export const INSTALLER_RELATIVE_DIRECTORY = './packages/tau-installer';

const releaseDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = dirname(releaseDirectory);

export function readExpectedInstallerVersion(
  manifestPath = join(repositoryRoot, 'packages', 'tau-installer', 'package.json'),
) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.name !== INSTALLER_PACKAGE || typeof manifest.version !== 'string') {
    throw new Error(`Invalid oio installer manifest at ${manifestPath}`);
  }
  return manifest.version;
}

function parseJson(stdout) {
  const value = String(stdout ?? '').trim();
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function parseRegistryMetadata(stdout) {
  const parsed = parseJson(stdout);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const version = typeof parsed.version === 'string' ? parsed.version : '';
  const integrity =
    typeof parsed['dist.integrity'] === 'string'
      ? parsed['dist.integrity']
      : typeof parsed.dist?.integrity === 'string'
        ? parsed.dist.integrity
        : '';
  return version && integrity ? { version, integrity } : null;
}

function parseLocalPackMetadata(stdout) {
  const parsed = parseJson(stdout);
  const packed = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!packed || typeof packed !== 'object') return null;

  const name = typeof packed.name === 'string' ? packed.name : '';
  const version = typeof packed.version === 'string' ? packed.version : '';
  const integrity = typeof packed.integrity === 'string' ? packed.integrity : '';
  return name && version && integrity ? { name, version, integrity } : null;
}

function invokeNpm(spawnSyncImpl, nodeExecPath, npmExecPath, args) {
  try {
    const result = spawnSyncImpl(nodeExecPath, [npmExecPath, ...args], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
    });
    return result && typeof result === 'object'
      ? result
      : {
          status: null,
          stdout: '',
          stderr: '',
          error: new Error('npm did not return a command result.'),
        };
  } catch (error) {
    return { status: null, stdout: '', stderr: '', error };
  }
}

function commandFailureDetails(result) {
  return [result.error ? String(result.error.message ?? result.error) : '', String(result.stderr ?? '').trim()]
    .filter(Boolean)
    .join('\n');
}

export function verifyInstallerPublished(options = {}) {
  const expectedVersion = options.expectedVersion ?? readExpectedInstallerVersion();
  const npmExecPath = options.npmExecPath ?? process.env.npm_execpath;
  const nodeExecPath = options.nodeExecPath ?? process.env.npm_node_execpath ?? process.execPath;
  const spawnSyncImpl = options.spawnSyncImpl ?? spawnSync;

  if (!npmExecPath) {
    throw new Error(
      'Cannot locate the invoking npm CLI. Run this release gate through `npm publish`.',
    );
  }

  const registryResult = invokeNpm(
    spawnSyncImpl,
    nodeExecPath,
    npmExecPath,
    [
      'view',
      `${INSTALLER_PACKAGE}@latest`,
      'version',
      'dist.integrity',
      '--json',
      '--prefer-online',
    ],
  );

  if (registryResult.status !== 0) {
    const details = commandFailureDetails(registryResult);
    throw new Error(
      [
        `${INSTALLER_PACKAGE}@latest is not available from npm.`,
        `Publish installer ${expectedVersion} from packages/tau-installer before publishing Tau.`,
        details,
      ].filter(Boolean).join('\n'),
    );
  }

  const published = parseRegistryMetadata(registryResult.stdout);
  if (!published) {
    throw new Error(
      `${INSTALLER_PACKAGE}@latest returned invalid version or dist.integrity metadata. ` +
      `Publish installer ${expectedVersion} and verify the registry response before publishing Tau.`,
    );
  }

  if (published.version !== expectedVersion) {
    throw new Error(
      `${INSTALLER_PACKAGE}@latest is ${published.version}, but this Tau release expects ` +
      `${expectedVersion}. Publish the installer first and verify its latest tag.`,
    );
  }

  const packResult = invokeNpm(
    spawnSyncImpl,
    nodeExecPath,
    npmExecPath,
    [
      'pack',
      '--json',
      '--dry-run',
      '--ignore-scripts',
      INSTALLER_RELATIVE_DIRECTORY,
    ],
  );
  if (packResult.status !== 0) {
    const details = commandFailureDetails(packResult);
    throw new Error(
      [
        `Unable to compute the local ${INSTALLER_PACKAGE} tarball integrity with npm pack.`,
        details,
      ].filter(Boolean).join('\n'),
    );
  }

  const localPack = parseLocalPackMetadata(packResult.stdout);
  if (!localPack) {
    throw new Error(
      `npm pack returned invalid name, version, or integrity metadata for the local installer.`,
    );
  }
  if (localPack.name !== INSTALLER_PACKAGE || localPack.version !== expectedVersion) {
    throw new Error(
      `npm pack produced ${localPack.name}@${localPack.version}, but expected ` +
      `${INSTALLER_PACKAGE}@${expectedVersion}.`,
    );
  }
  if (localPack.integrity !== published.integrity) {
    throw new Error(
      `${INSTALLER_PACKAGE}@${expectedVersion} on npm does not match the local installer tarball. ` +
      `Registry integrity is ${published.integrity}; local npm pack integrity is ` +
      `${localPack.integrity}. Publish the exact local installer before publishing Tau.`,
    );
  }

  return published.version;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const version = verifyInstallerPublished();
    process.stdout.write(`[tau] Verified ${INSTALLER_PACKAGE}@${version} is published.\n`);
  } catch (error) {
    process.stderr.write(`[tau] Release blocked: ${error instanceof Error ? error.message : error}\n`);
    process.exitCode = 1;
  }
}
