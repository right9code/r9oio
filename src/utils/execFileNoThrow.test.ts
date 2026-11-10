/** Focused regression tests for Windows taskkill executable resolution. */

import { resolveWindowsTaskkillPath } from './execFileNoThrow.js'

let passed = 0
let failed = 0

function assertEqual(actual: unknown, expected: unknown, message: string) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`)
  }
}

function test(name: string, run: () => void) {
  try {
    run()
    passed += 1
    console.log(`  ok  ${name}`)
  } catch (error) {
    failed += 1
    console.error(
      `  FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

console.log('Windows taskkill path safety:')

test('uses the configured absolute SystemRoot on any drive', () => {
  assertEqual(
    resolveWindowsTaskkillPath({ SystemRoot: 'D:\\Windows' }),
    'D:\\Windows\\System32\\taskkill.exe',
    'wrong taskkill path',
  )
})

test('uses WINDIR when SystemRoot is unavailable', () => {
  assertEqual(
    resolveWindowsTaskkillPath({ WINDIR: 'E:\\Windows' }),
    'E:\\Windows\\System32\\taskkill.exe',
    'wrong WINDIR taskkill path',
  )
})

test('fails closed instead of assuming drive C or trusting PATH', () => {
  assertEqual(resolveWindowsTaskkillPath({}), null, 'empty environment was accepted')
  assertEqual(
    resolveWindowsTaskkillPath({
      SystemRoot: 'relative\\Windows',
      WINDIR: 'F:\\Windows\ninvalid',
    }),
    null,
    'unsafe Windows root was accepted',
  )
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
