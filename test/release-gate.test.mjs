import assert from 'node:assert/strict';
import test from 'node:test';

import {
  INSTALLER_PACKAGE,
  INSTALLER_RELATIVE_DIRECTORY,
  verifyInstallerPublished,
} from '../release/verify-installer-published.mjs';

const EXPECTED_VERSION = '0.1.2';
const PUBLISHED_INTEGRITY = 'sha512-published';
const invocation = {
  expectedVersion: EXPECTED_VERSION,
  npmExecPath: '/opt/npm/bin/npm-cli.js',
  nodeExecPath: '/opt/node/bin/node',
};

function registryResult({
  version = EXPECTED_VERSION,
  integrity = PUBLISHED_INTEGRITY,
} = {}) {
  return {
    status: 0,
    stdout: JSON.stringify({ version, 'dist.integrity': integrity }),
    stderr: '',
  };
}

function packResult({
  name = INSTALLER_PACKAGE,
  version = EXPECTED_VERSION,
  integrity = PUBLISHED_INTEGRITY,
} = {}) {
  return {
    status: 0,
    stdout: JSON.stringify([{ name, version, integrity }]),
    stderr: '',
  };
}

function sequenceSpawn(results, calls = []) {
  return {
    calls,
    spawnSyncImpl(command, args, options) {
      calls.push({ command, args, options });
      assert.ok(results.length > 0, 'unexpected npm command');
      const next = results.shift();
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

test('release gate verifies latest version and exact local tarball integrity without a shell', () => {
  const npm = sequenceSpawn([registryResult(), packResult()]);
  const version = verifyInstallerPublished({
    ...invocation,
    spawnSyncImpl: npm.spawnSyncImpl,
  });

  assert.equal(version, EXPECTED_VERSION);
  assert.equal(npm.calls.length, 2);
  assert.equal(npm.calls[0].command, invocation.nodeExecPath);
  assert.deepEqual(npm.calls[0].args, [
    invocation.npmExecPath,
    'view',
    `${INSTALLER_PACKAGE}@latest`,
    'version',
    'dist.integrity',
    '--json',
    '--prefer-online',
  ]);
  assert.deepEqual(npm.calls[1].args, [
    invocation.npmExecPath,
    'pack',
    '--json',
    '--dry-run',
    '--ignore-scripts',
    INSTALLER_RELATIVE_DIRECTORY,
  ]);
  for (const call of npm.calls) {
    assert.equal(call.options.shell, false);
    assert.equal(call.options.encoding, 'utf8');
    assert.equal(typeof call.options.cwd, 'string');
  }
});

test('release gate blocks Tau when latest points at another installer version', () => {
  const npm = sequenceSpawn([registryResult({ version: '0.1.1' })]);

  assert.throws(
    () => verifyInstallerPublished({
      ...invocation,
      spawnSyncImpl: npm.spawnSyncImpl,
    }),
    /latest is 0\.1\.1.*expects 0\.1\.2/s,
  );
  assert.equal(npm.calls.length, 1, 'a version mismatch must stop before packing');
});

test('release gate blocks Tau when the published and local installer integrities differ', () => {
  const npm = sequenceSpawn([
    registryResult(),
    packResult({ integrity: 'sha512-local' }),
  ]);

  assert.throws(
    () => verifyInstallerPublished({
      ...invocation,
      spawnSyncImpl: npm.spawnSyncImpl,
    }),
    /does not match the local installer tarball.*Registry integrity is sha512-published.*local npm pack integrity is sha512-local/s,
  );
});

test('release gate blocks Tau when the registry command fails', () => {
  const npm = sequenceSpawn([
    { status: 1, stdout: '', stderr: 'E404: package not found' },
  ]);

  assert.throws(
    () => verifyInstallerPublished({
      ...invocation,
      spawnSyncImpl: npm.spawnSyncImpl,
    }),
    /not available from npm.*Publish installer 0\.1\.2.*E404/s,
  );
});

test('release gate blocks Tau when npm pack fails', () => {
  const npm = sequenceSpawn([
    registryResult(),
    { status: 1, stdout: '', stderr: 'EPERM: cannot read package' },
  ]);

  assert.throws(
    () => verifyInstallerPublished({
      ...invocation,
      spawnSyncImpl: npm.spawnSyncImpl,
    }),
    /Unable to compute.*npm pack.*EPERM/s,
  );
});

test('release gate reports npm process launch failures as a blocked release', () => {
  const npm = sequenceSpawn([new Error('spawn ENOENT')]);

  assert.throws(
    () => verifyInstallerPublished({
      ...invocation,
      spawnSyncImpl: npm.spawnSyncImpl,
    }),
    /not available from npm.*spawn ENOENT/s,
  );
});
