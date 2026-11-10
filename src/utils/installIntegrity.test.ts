/**
 * Launcher-safety regression tests.
 *
 * Run: bun run src/utils/installIntegrity.test.ts
 */

import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import {
  cleanStaleBinShims,
  getRunningPackageRoot,
  packageRootsMatch,
  removeConflictingShim,
} from './installIntegrity.js'
import { cleanDanglingBinShims } from '../../scripts/preinstall.mjs'

const TAU_PACKAGE = '@right9/oio'

type Fixture = {
  prefix: string
  binDir: string
  packageRoot: string
}

let passed = 0
let failed = 0

function entryExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function makeFixture(): Fixture {
  const prefix = mkdtempSync(join(tmpdir(), 'tau-launcher-safety-'))
  const binDir = process.platform === 'win32' ? prefix : join(prefix, 'bin')
  const packageRoot =
    process.platform === 'win32'
      ? join(prefix, 'node_modules', ...TAU_PACKAGE.split('/'))
      : join(prefix, 'lib', 'node_modules', ...TAU_PACKAGE.split('/'))
  mkdirSync(binDir, { recursive: true })
  return { prefix, binDir, packageRoot }
}

function createTarget(root: string, packageName: string): string {
  const target = join(root, 'node_modules', ...packageName.split('/'), 'dist', 'cli.mjs')
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, '// healthy launcher target\n')
  return target
}

function createTauTarget(fixture: Fixture): string {
  const target = join(fixture.packageRoot, 'dist', 'cli.mjs')
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, '// healthy Tau launcher target\n')
  return target
}

function launcherPath(fixture: Fixture, name: 'tau' | 'claudex'): string {
  return join(fixture.binDir, process.platform === 'win32' ? `${name}.cmd` : name)
}

function createLauncher(
  fixture: Fixture,
  name: 'tau' | 'claudex',
  target: string,
): string {
  const path = launcherPath(fixture, name)
  if (process.platform === 'win32') {
    const relativeTarget = relative(fixture.binDir, target)
    writeFileSync(path, `@ECHO off\nnode "%~dp0%\\${relativeTarget}" %*\n`)
  } else {
    symlinkSync(target, path)
  }
  return path
}

async function withFixture(run: (fixture: Fixture) => Promise<void> | void) {
  const fixture = makeFixture()
  try {
    await run(fixture)
  } finally {
    rmSync(fixture.prefix, { recursive: true, force: true })
  }
}

async function test(name: string, run: () => Promise<void> | void) {
  try {
    await run()
    passed += 1
    console.log(`  ok  ${name}`)
  } catch (error) {
    failed += 1
    console.error(
      `  FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

console.log('launcher safety:')

await test('updater preflight preserves a healthy Tau launcher', () =>
  withFixture(async fixture => {
    const launcher = createLauncher(fixture, 'tau', createTauTarget(fixture))
    await cleanStaleBinShims(fixture.prefix, false, TAU_PACKAGE)
    assert(entryExists(launcher), 'healthy Tau launcher was removed before npm ran')
  }),
)

await test('updater preflight preserves a healthy absolute-path Tau launcher', () =>
  withFixture(async fixture => {
    const externalRoot = join(fixture.prefix, 'external-install')
    const target = createTarget(externalRoot, TAU_PACKAGE)
    const launcher = launcherPath(fixture, 'claudex')
    writeFileSync(launcher, `node "${target}"\n`)

    await cleanStaleBinShims(fixture.prefix, false, TAU_PACKAGE)
    assert(
      entryExists(launcher),
      'healthy absolute-path Tau launcher was mistaken for dangling',
    )
  }),
)

await test('updater preflight removes a dangling launcher', () =>
  withFixture(async fixture => {
    const launcher = createLauncher(
      fixture,
      'claudex',
      join(fixture.packageRoot, 'dist', 'missing.mjs'),
    )
    await cleanStaleBinShims(fixture.prefix, false, TAU_PACKAGE)
    assert(!entryExists(launcher), 'dangling launcher was not removed')
  }),
)

await test('package preinstall preserves healthy Tau and foreign launchers', () =>
  withFixture(fixture => {
    const tauLauncher = createLauncher(fixture, 'tau', createTauTarget(fixture))
    const foreignTarget = createTarget(
      join(fixture.prefix, 'external-install'),
      'foreign-cli',
    )
    const foreignLauncher = launcherPath(fixture, 'claudex')
    writeFileSync(foreignLauncher, `node "${foreignTarget}"\n`)

    cleanDanglingBinShims(fixture.binDir, TAU_PACKAGE)

    assert(entryExists(tauLauncher), 'preinstall removed the healthy Tau launcher')
    assert(entryExists(foreignLauncher), 'preinstall removed a healthy foreign launcher')
  }),
)

await test('package preinstall removes only a dangling launcher', () =>
  withFixture(fixture => {
    const launcher = createLauncher(
      fixture,
      'tau',
      join(fixture.packageRoot, 'dist', 'missing.mjs'),
    )
    cleanDanglingBinShims(fixture.binDir, TAU_PACKAGE)
    assert(!entryExists(launcher), 'preinstall left a dangling launcher in place')
  }),
)

await test('confirmed EEXIST retry removes a healthy Tau-owned conflict', () =>
  withFixture(async fixture => {
    const launcher = createLauncher(fixture, 'tau', createTauTarget(fixture))
    const removed = await removeConflictingShim(
      launcher,
      fixture.prefix,
      false,
      TAU_PACKAGE,
    )
    assert(removed, 'confirmed Tau-owned conflict was not removed')
    assert(!entryExists(launcher), 'Tau-owned conflict still exists')
  }),
)

await test('confirmed EEXIST retry removes a dangling conflict', () =>
  withFixture(async fixture => {
    const launcher = createLauncher(
      fixture,
      'claudex',
      join(fixture.packageRoot, 'dist', 'missing.mjs'),
    )
    const removed = await removeConflictingShim(
      launcher,
      fixture.prefix,
      false,
      TAU_PACKAGE,
    )
    assert(removed, 'dangling conflict was not removed')
    assert(!entryExists(launcher), 'dangling conflict still exists')
  }),
)

await test('confirmed EEXIST retry preserves a healthy foreign launcher', () =>
  withFixture(async fixture => {
    const foreignTarget = createTarget(fixture.prefix, 'foreign-cli')
    const launcher = createLauncher(fixture, 'tau', foreignTarget)
    const removed = await removeConflictingShim(
      launcher,
      fixture.prefix,
      false,
      TAU_PACKAGE,
    )
    assert(!removed, 'healthy foreign launcher was reported as removed')
    assert(entryExists(launcher), 'healthy foreign launcher was deleted')
  }),
)

await test('confirmed EEXIST retry refuses a Tau launcher outside the global bin', () =>
  withFixture(async fixture => {
    const outsideDir = join(fixture.prefix, 'outside')
    mkdirSync(outsideDir, { recursive: true })
    const target = createTauTarget(fixture)
    const launcher = join(
      outsideDir,
      process.platform === 'win32' ? 'tau.cmd' : 'tau',
    )
    if (process.platform === 'win32') {
      writeFileSync(
        launcher,
        `@ECHO off\nnode "%~dp0%\\${relative(outsideDir, target)}" %*\n`,
      )
    } else {
      symlinkSync(target, launcher)
    }

    const removed = await removeConflictingShim(
      launcher,
      fixture.prefix,
      false,
      TAU_PACKAGE,
    )
    assert(!removed, 'out-of-bin launcher was reported as removed')
    assert(entryExists(launcher), 'out-of-bin launcher was deleted')
  }),
)

await test('non-Windows EEXIST paths do not alias .cmd onto the Tau launcher', () => {
  if (process.platform === 'win32') return
  return withFixture(async fixture => {
    const launcher = createLauncher(fixture, 'tau', createTauTarget(fixture))
    const removed = await removeConflictingShim(
      `${launcher}.cmd`,
      fixture.prefix,
      false,
      TAU_PACKAGE,
    )
    assert(!removed, 'a non-Windows .cmd path was treated as the Tau launcher')
    assert(entryExists(launcher), 'the healthy Unix Tau launcher was removed')
  })
})

await test('a package-name mention alone is not proof of Tau ownership', () =>
  withFixture(async fixture => {
    const launcher = launcherPath(fixture, 'tau')
    writeFileSync(launcher, `echo documentation for ${TAU_PACKAGE}\n`)
    const removed = await removeConflictingShim(
      launcher,
      fixture.prefix,
      false,
      TAU_PACKAGE,
    )
    assert(!removed, 'unproven launcher was reported as removed')
    assert(entryExists(launcher), 'unproven launcher was deleted')
  }),
)

await test('global-prefix comparison resolves the running package canonically', () =>
  withFixture(async fixture => {
    createTauTarget(fixture)
    const invokedEntry = join(fixture.packageRoot, 'dist', 'cli.mjs')
    assert(
      getRunningPackageRoot(invokedEntry) === fixture.packageRoot,
      'running entry did not resolve to its package root',
    )

    const launcherGlobal = globalThis as typeof globalThis & {
      __TAU_PACKAGE_ROOT__?: string
    }
    const previousLauncherRoot = launcherGlobal.__TAU_PACKAGE_ROOT__
    launcherGlobal.__TAU_PACKAGE_ROOT__ = fixture.packageRoot
    try {
      assert(
        getRunningPackageRoot() === fixture.packageRoot,
        'launcher-provided package root was ignored',
      )
    } finally {
      if (previousLauncherRoot === undefined) {
        delete launcherGlobal.__TAU_PACKAGE_ROOT__
      } else {
        launcherGlobal.__TAU_PACKAGE_ROOT__ = previousLauncherRoot
      }
    }

    const alias = join(fixture.prefix, 'tau-package-alias')
    symlinkSync(
      fixture.packageRoot,
      alias,
      process.platform === 'win32' ? 'junction' : 'dir',
    )
    assert(
      await packageRootsMatch(alias, fixture.packageRoot),
      'canonical symlinked package roots did not match',
    )
    assert(
      !(await packageRootsMatch(
        fixture.packageRoot,
        join(fixture.prefix, 'different-global-root'),
      )),
      'different global package roots were treated as the same installation',
    )
  }),
)

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
