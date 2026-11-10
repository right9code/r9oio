/**
 * Output distillation checks.
 *
 * Run via: bun run src/utils/outputDistill.test.ts
 */

import { distillCommandOutput } from './outputDistill.js'

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

function jestRun(passing: number, failures: number): string {
  const lines: string[] = ['> tau@0.92.12 test', '> jest --colors=never', '']
  for (let suite = 0; suite < 4; suite++) {
    lines.push(`PASS src/suite${suite}.test.ts`)
  }
  for (let i = 0; i < passing; i++) {
    lines.push(`  ✓ renders widget variant ${i} correctly (${(i % 9) + 1} ms)`)
  }
  for (let i = 0; i < failures; i++) {
    lines.push(`  ✕ computes total for cart ${i} (14 ms)`)
    lines.push(`    expect(received).toBe(expected)`)
    lines.push(`    Expected: ${i + 3}`)
    lines.push(`    Received: ${i + 4}`)
    lines.push(`      at src/cart.test.ts:${40 + i}:15`)
    lines.push('')
  }
  lines.push('')
  lines.push(`Tests:       ${failures} failed, ${passing} passed, ${passing + failures} total`)
  lines.push('Test Suites: 1 failed, 4 passed, 5 total')
  lines.push('Time:        12.42 s')
  return lines.join('\n')
}

console.log('distillCommandOutput:')

test('short output returns null', () => {
  assert(distillCommandOutput('a\nb\nc', 2000) === null, 'expected null')
})

test('unstructured log output returns null', () => {
  const log = Array.from(
    { length: 300 },
    (_, i) => `processing item ${i} with metadata payload alpha beta gamma delta`,
  ).join('\n')
  assert(distillCommandOutput(log, 2000) === null, 'expected null')
})

test('jest run with failures keeps failure details and summary, collapses passes', () => {
  const out = distillCommandOutput(jestRun(290, 2), 2000)
  assert(out !== null, 'expected distillation')
  assert(out!.includes('✕ computes total for cart 0'), 'missing failure line')
  assert(out!.includes('Expected: 3'), 'missing assertion detail')
  assert(out!.includes('Tests:       2 failed, 290 passed, 292 total'), 'missing summary')
  assert(!out!.includes('renders widget variant 42'), 'passing noise leaked through')
  assert(out!.length <= 2000, `over budget: ${out!.length}`)
})

test('all-green jest run collapses to summary', () => {
  const out = distillCommandOutput(jestRun(298, 0), 2000)
  assert(out !== null, 'expected distillation')
  assert(out!.includes('298 passed'), 'missing pass count')
  assert(!out!.includes('renders widget variant 100'), 'passing noise leaked through')
})

test('passing test whose name mentions Error is not kept as a failure', () => {
  const lines: string[] = []
  for (let i = 0; i < 40; i++) lines.push(`  ✓ Error handling case ${i} works (2 ms)`)
  lines.push('Tests:       40 passed, 40 total')
  lines.push('Time:        1.2 s')
  // Pad to clear the 2000-char floor.
  for (let i = 0; i < 30; i++) lines.push(`  ✓ padding case with a reasonably long descriptive name ${i}`)
  const out = distillCommandOutput(lines.join('\n'), 2000)
  assert(out !== null, 'expected distillation')
  assert(!out!.includes('Error handling case 25'), 'pass line misclassified as failure')
})

test('pytest run keeps FAILED lines and short summary', () => {
  const lines: string[] = ['============ test session starts =============', 'collected 220 items', '']
  for (let i = 0; i < 8; i++) {
    lines.push('....................F.........  [ ' + String(12 * (i + 1)).padStart(2) + '%]')
  }
  lines.push('', '=================== FAILURES ===================')
  lines.push('_____________ test_cart_total _____________')
  lines.push('    def test_cart_total():')
  lines.push('>       assert total == 3')
  lines.push('E       assert 4 == 3')
  lines.push('', '=========== short test summary info ===========')
  lines.push('FAILED tests/test_cart.py::test_cart_total - assert 4 == 3')
  lines.push('========= 1 failed, 219 passed in 8.21s =========')
  // Pad with more progress rows so the input clears the size floor.
  for (let i = 0; i < 40; i++) {
    lines.push('..............................  [100%]'.slice(0, 38))
  }
  const out = distillCommandOutput(lines.join('\n'), 2000)
  assert(out !== null, 'expected distillation')
  assert(out!.includes('FAILED tests/test_cart.py::test_cart_total'), 'missing FAILED line')
  assert(out!.includes('1 failed, 219 passed'), 'missing summary')
})

test('tsc-style diagnostics are kept', () => {
  const lines: string[] = []
  for (let i = 0; i < 30; i++) {
    lines.push(`src/module${i}.ts(${10 + i},5): error TS2304: Cannot find name 'foo${i}'.`)
  }
  for (let i = 0; i < 60; i++) {
    lines.push(`  loading project reference ${i} with long descriptive path segments here`)
  }
  lines.push('Found 30 errors in 30 files.')
  const out = distillCommandOutput(lines.join('\n'), 4000)
  assert(out !== null, 'expected distillation')
  assert(out!.includes('error TS2304'), 'missing diagnostics')
  assert(out!.includes('Found 30 errors'), 'missing closing summary')
})

test('summary survives even when failures exceed the budget', () => {
  const out = distillCommandOutput(jestRun(50, 40), 1200)
  assert(out !== null, 'expected distillation')
  assert(out!.includes('40 failed, 50 passed'), 'summary was squeezed out')
  assert(out!.length <= 1200, `over budget: ${out!.length}`)
  assert(out!.includes('more failure/diagnostic'), 'missing omitted-blocks note')
})

test('deterministic: byte-identical across calls', () => {
  const input = jestRun(200, 3)
  const a = distillCommandOutput(input, 2000)
  const b = distillCommandOutput(input, 2000)
  assert(a !== null && a === b, 'nondeterministic output')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
