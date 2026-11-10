/**
 * Updater-lock regression tests.
 *
 * Run: bun run src/utils/updateLock.test.ts
 */

import {
  lstatSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { UpdateLock } from './updateLock.js'

let passed = 0
let failed = 0

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function test(name: string, run: () => Promise<void>) {
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

function manager(
  lockPath: string,
  isProcessAlive: (pid: number) => boolean = () => false,
): UpdateLock {
  return new UpdateLock({
    getLockPath: () => lockPath,
    staleMs: 1_000,
    heartbeatMs: 100,
    isProcessAlive,
  })
}

function agePath(path: string): void {
  const stale = new Date(Date.now() - 10_000)
  utimesSync(path, stale, stale)
}

async function withFixture(run: (lockPath: string) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'tau-update-lock-'))
  try {
    await run(join(root, '.update.lock'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

console.log('update lock:')

await test('migrates a stale legacy lock file without unlinking the shared path', () =>
  withFixture(async lockPath => {
    writeFileSync(lockPath, '12345')
    agePath(lockPath)

    const lock = manager(lockPath)
    assert(await lock.acquire(), 'stale legacy file was not recovered')
    assert(lstatSync(lockPath).isDirectory(), 'legacy file was not migrated')
    assert(readdirSync(lockPath).length === 1, 'owner UUID lease is missing')
    await lock.release()
  }),
)

await test('a fresh legacy lock file remains untouched', () =>
  withFixture(async lockPath => {
    writeFileSync(lockPath, '12345')
    const lock = manager(lockPath)
    assert(!(await lock.acquire()), 'fresh legacy lock was stolen')
    assert(lstatSync(lockPath).isFile(), 'fresh legacy lock was modified')
  }),
)

await test('stale contenders elect one owner and delayed cleanup preserves it', () =>
  withFixture(async lockPath => {
    const staleOwner = manager(lockPath)
    assert(await staleOwner.acquire(), 'fixture owner did not acquire')
    const [staleLease] = readdirSync(lockPath)
    assert(staleLease, 'fixture lease is missing')
    agePath(join(lockPath, staleLease))

    const first = manager(lockPath)
    const second = manager(lockPath)
    const results = await Promise.all([first.acquire(), second.acquire()])
    assert(
      results.filter(Boolean).length === 1,
      `expected one winner, got ${JSON.stringify(results)}`,
    )

    const winner = results[0] ? first : second
    await staleOwner.release()
    assert(
      lstatSync(lockPath).isDirectory() && readdirSync(lockPath).length === 1,
      'delayed stale-owner release removed the replacement lock',
    )

    const blocked = manager(lockPath)
    assert(!(await blocked.acquire()), 'replacement lock did not block a contender')
    await winner.release()
  }),
)

await test('a stale lease remains held while its owner PID is alive', () =>
  withFixture(async lockPath => {
    const owner = manager(lockPath)
    assert(await owner.acquire(), 'fixture owner did not acquire')
    const [lease] = readdirSync(lockPath)
    assert(lease, 'fixture lease is missing')
    agePath(join(lockPath, lease))

    const contender = manager(lockPath, pid => pid === process.pid)
    assert(
      !(await contender.acquire()),
      'stale timestamp overrode a live synchronous owner PID',
    )
    await owner.release()
  }),
)

await test('a stale legacy file remains held while its owner PID is alive', () =>
  withFixture(async lockPath => {
    writeFileSync(lockPath, String(process.pid))
    agePath(lockPath)

    const contender = manager(lockPath, pid => pid === process.pid)
    assert(
      !(await contender.acquire()),
      'legacy lock belonging to a live PID was stolen',
    )
    assert(lstatSync(lockPath).isFile(), 'live legacy lock was modified')
  }),
)

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
