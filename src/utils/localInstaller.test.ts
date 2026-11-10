/**
 * Focused regression tests for managed-local manifest replacement.
 *
 * Run: bun run src/utils/localInstaller.test.ts
 */

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { atomicReplaceTextFile } from './atomicFile.js'
import {
  buildManagedLocalWrapper,
  quotePosixShellArgument,
} from './localWrapper.js'
import { withManagedLocalUpdateLock } from './managedLocalUpdateLock.js'
import { UpdateLock } from './updateLock.js'

let passed = 0
let failed = 0

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function assertNoTemporaryFile(parent: string, target: string): void {
  const prefix = `.${basename(target)}.`
  const leftovers = readdirSync(parent).filter(
    name => name.startsWith(prefix) && name.endsWith('.tmp'),
  )
  assert(
    leftovers.length === 0,
    `temporary files were not cleaned up: ${leftovers.join(', ')}`,
  )
}

async function test(name: string, run: () => Promise<void>): Promise<void> {
  try {
    await run()
    passed++
    console.log(`ok - ${name}`)
  } catch (error) {
    failed++
    console.error(`not ok - ${name}`)
    console.error(error)
  }
}

const root = mkdtempSync(join(tmpdir(), 'tau-local-installer-atomic-'))

try {
  await test('atomically replaces the exact requested bytes', async () => {
    const target = join(root, 'package.json')
    const replacement = '{\r\n  "private": true,\r\n  "allowScripts": {}\r\n}\r\n'
    writeFileSync(target, '{"old":true}\n', 'utf8')

    await atomicReplaceTextFile(target, replacement)

    assert(
      readFileSync(target, 'utf8') === replacement,
      'replacement changed formatting or newline bytes',
    )
    assertNoTemporaryFile(root, target)
  })

  await test('cleans up its temporary file when rename fails', async () => {
    const target = join(root, 'occupied-target')
    mkdirSync(target)
    writeFileSync(join(target, 'keep.txt'), 'keep', 'utf8')

    let rejected = false
    try {
      await atomicReplaceTextFile(target, 'replacement')
    } catch {
      rejected = true
    }

    assert(rejected, 'replacement unexpectedly succeeded over a directory')
    assert(
      readFileSync(join(target, 'keep.txt'), 'utf8') === 'keep',
      'failed replacement modified the destination',
    )
    assertNoTemporaryFile(root, target)
  })

  await test(
    'serializes the complete managed-local mutation window across lock instances',
    async () => {
      const lockPath = join(root, 'managed-local-update.lock')
      const createLock = () =>
        new UpdateLock({
          getLockPath: () => lockPath,
          staleMs: 60_000,
          heartbeatMs: 10_000,
        })
      const firstLock = createLock()
      const contenderLock = createLock()
      let releaseFirst!: () => void
      const firstMayFinish = new Promise<void>(resolve => {
        releaseFirst = resolve
      })
      let firstStarted!: () => void
      const firstDidStart = new Promise<void>(resolve => {
        firstStarted = resolve
      })

      const first = withManagedLocalUpdateLock(async () => {
        firstStarted()
        await firstMayFinish
        return 'success'
      }, firstLock)
      await firstDidStart

      let contenderRan = false
      const contended = await withManagedLocalUpdateLock(async () => {
        contenderRan = true
        return 'success'
      }, contenderLock)
      assert(contended === 'in_progress', 'contender did not report contention')
      assert(!contenderRan, 'contender entered the protected mutation window')

      releaseFirst()
      assert((await first) === 'success', 'lock owner did not finish successfully')

      const afterRelease = await withManagedLocalUpdateLock(async () => {
        contenderRan = true
        return 'success'
      }, contenderLock)
      assert(afterRelease === 'success', 'released lease remained stuck')
      assert(contenderRan, 'operation did not run after lease release')
    },
  )

  await test('releases the managed-local lease when mutation throws', async () => {
    const lockPath = join(root, 'managed-local-throw.lock')
    const createLock = () =>
      new UpdateLock({
        getLockPath: () => lockPath,
        staleMs: 60_000,
        heartbeatMs: 10_000,
      })
    let rejected = false
    try {
      await withManagedLocalUpdateLock(async () => {
        throw new Error('simulated mutation failure')
      }, createLock())
    } catch {
      rejected = true
    }
    assert(rejected, 'simulated mutation failure did not propagate')

    const recovered = await withManagedLocalUpdateLock(
      async () => 'success',
      createLock(),
    )
    assert(recovered === 'success', 'failed mutation leaked its lease')
  })

  await test('keeps the heartbeat active for the entire mutation', async () => {
    const events: string[] = []
    const lease = {
      async acquire() {
        events.push('acquire')
        return true
      },
      startHeartbeat() {
        events.push('heartbeat-start')
        return async () => {
          events.push('heartbeat-stop')
        }
      },
      async release() {
        events.push('release')
      },
    }

    const result = await withManagedLocalUpdateLock(async () => {
      events.push('mutation')
      return 'success'
    }, lease)

    assert(result === 'success', 'protected mutation did not succeed')
    assert(
      events.join(',') ===
        'acquire,heartbeat-start,mutation,heartbeat-stop,release',
      `unexpected lease order: ${events.join(',')}`,
    )
  })

  await test('quotes every shell-sensitive character in local wrapper paths', async () => {
    const windowsDir =
      'C:\\Users\\O\'Brien\\cash$\\`ticks`\\"quotes"\\with spaces'
    const normalizedTarget =
      'C:/Users/O\'Brien/cash$/`ticks`/"quotes"/with spaces/node_modules/.bin/tau'
    const wrapper = buildManagedLocalWrapper(windowsDir, 'win32')

    assert(
      wrapper ===
        `#!/bin/sh\nexec ${quotePosixShellArgument(normalizedTarget)} "$@"\n`,
      'wrapper did not safely quote the exact normalized target',
    )
    assert(
      !wrapper.includes('\\'),
      'Windows separators leaked into the sh wrapper target',
    )
    assert(
      wrapper.includes(`O'"'"'Brien`),
      'embedded apostrophe was not encoded for a POSIX shell',
    )
  })
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log(`${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
