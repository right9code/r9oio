import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const updateSource = await readFile(
  new URL('../src/cli/update.ts', import.meta.url),
  'utf8',
)
const autoUpdaterSource = (
  await readFile(
    new URL('../src/components/AutoUpdater.tsx', import.meta.url),
    'utf8',
  )
).split('//# sourceMappingURL=')[0]
const buildSource = await readFile(new URL('../build.mjs', import.meta.url), 'utf8')

test('interactive updates fail closed for an unknown installation', () => {
  const branchStart = updateSource.indexOf("case 'unknown': {")
  const branchEnd = updateSource.indexOf('default:', branchStart)
  assert.notEqual(branchStart, -1, 'expected an unknown-installation branch')
  assert.notEqual(branchEnd, -1, 'expected the next switch branch')
  const unknownCase = updateSource.slice(branchStart, branchEnd)
  assert.match(unknownCase, /No update was attempted/)
  assert.match(unknownCase, /gracefulShutdown\(1\)/)
  assert.doesNotMatch(unknownCase, /localInstallationExists/)
  assert.doesNotMatch(unknownCase, /installGlobalPackage/)
  assert.doesNotMatch(unknownCase, /installOrUpdateTauPackage/)

  const cleanup = updateSource.indexOf(
    'await removeInstalledSymlink()',
    branchEnd,
  )
  const successCase = updateSource.indexOf("case 'success':", branchEnd)
  assert.ok(successCase > branchEnd, 'expected update success handling')
  assert.ok(
    cleanup > successCase,
    'native launcher cleanup can run before route validation or install success',
  )
})

test('managed-local updates install the exact selected version', () => {
  assert.match(
    updateSource,
    /installOrUpdateTauPackage\(channel, latestVersion\)/,
  )
  assert.match(
    autoUpdaterSource,
    /installOrUpdateTauPackage\(channel, latestVersion\)/,
  )
})

test('npm-global updates bind to the package root that is actually running', () => {
  assert.match(
    buildSource,
    /globalThis\.__TAU_PACKAGE_ROOT__\s*=\s*packageRoot/,
  )
  assert.match(
    updateSource,
    /installGlobalPackage\(latestVersion,\s*\{[\s\S]*?expectedPackageRoot:\s*getRunningPackageRoot\(\)/,
  )
  assert.match(
    autoUpdaterSource,
    /installGlobalPackage\(latestVersion,\s*\{[\s\S]*?expectedPackageRoot:\s*getRunningPackageRoot\(\)/,
  )
  assert.match(autoUpdaterSource, /status === 'prefix_mismatch'/)
  assert.match(
    autoUpdaterSource,
    /npm prefix differs from running Tau[\s\S]*?tau doctor/,
  )
})
