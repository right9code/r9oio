/**
 * Cross-tool path normalization regression tests.
 *
 * Run: bun run src/utils/path.test.ts
 */

import { tmpdir } from 'os'
import { join, normalize } from 'path'
import { expandPath } from './path.js'
import { getPlatform } from './platform.js'

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (error: any) {
    failed++
    console.log(`  FAIL ${name}: ${error?.message ?? String(error)}`)
  }
}

function assertEqual(actual: unknown, expected: unknown, hint: string): void {
  if (actual !== expected) {
    throw new Error(
      `${hint}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`,
    )
  }
}

function main(): void {
  console.log('path normalization:')

  test('keeps normal absolute and relative path behavior', () => {
    const base = normalize(join(tmpdir(), 'tau-path-base'))
    assertEqual(
      expandPath('child/file.txt', base),
      normalize(join(base, 'child', 'file.txt')),
      'relative path must resolve from base',
    )
  })

  if (getPlatform() === 'windows') {
    test('maps Git Bash /tmp to the native per-user temp directory', () => {
      assertEqual(
        expandPath('/tmp/init.js'),
        normalize(join(tmpdir(), 'init.js')),
        'file tools and Git Bash must share one temp-file identity',
      )
      assertEqual(
        expandPath('/tmp'),
        normalize(tmpdir()),
        'the /tmp directory itself must map to os.tmpdir()',
      )
    })
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main()
