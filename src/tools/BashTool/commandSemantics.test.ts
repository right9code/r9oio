/**
 * Bash command semantics unit tests.
 *
 * Run: bun run src/tools/BashTool/commandSemantics.test.ts
 */

import { interpretCommandResult } from './commandSemantics.js'

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (e: any) {
    failed++
    console.log(`  FAIL ${name}: ${e?.message ?? String(e)}`)
  }
}

function assert(cond: unknown, hint: string): void {
  if (!cond) throw new Error(hint)
}

function main(): void {
  console.log('bash command semantics:')

  test('treats cmp exit 1 as file difference, not execution failure', () => {
    const result = interpretCommandResult('cmp a.txt b.txt', 1, '', '')

    assert(!result.isError, 'cmp exit 1 should not be treated as an error')
    assert(result.message === 'Files differ', 'cmp should explain exit 1')
  })

  test('treats cmp exit 2 as execution failure', () => {
    const result = interpretCommandResult('cmp a.txt missing.txt', 2, '', '')

    assert(result.isError, 'cmp exit 2 should be treated as an error')
  })

  test('preserves command semantics when stderr is redirected', () => {
    const result = interpretCommandResult('grep needle haystack.txt 2>&1', 1, '', '')

    assert(!result.isError, 'grep exit 1 should still mean no matches')
    assert(result.message === 'No matches found', 'grep should explain exit 1')
  })

  test('ignores leading environment assignments', () => {
    const result = interpretCommandResult('LC_ALL=C grep needle file.txt', 1, '', '')

    assert(!result.isError, 'env-prefixed grep exit 1 should mean no matches')
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main()
