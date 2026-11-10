import { parseCellId } from './notebookCellId.js'

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

function assertEqual(actual: unknown, expected: unknown, hint: string): void {
  if (actual !== expected) {
    throw new Error(`${hint}: expected ${String(expected)}, got ${String(actual)}`)
  }
}

test('parseCellId accepts notebook Read cell IDs', () => {
  assertEqual(parseCellId('cell-0'), 0, 'cell-0 should map to index 0')
  assertEqual(parseCellId('cell-12'), 12, 'cell-12 should map to index 12')
})

test('parseCellId tolerates bare numeric cell indexes', () => {
  assertEqual(parseCellId('0'), 0, '0 should map to index 0')
  assertEqual(parseCellId('12'), 12, '12 should map to index 12')
})

test('parseCellId rejects non-cell identifiers', () => {
  assertEqual(parseCellId('intro'), undefined, 'plain ids should not parse')
  assertEqual(parseCellId('cell-a'), undefined, 'non-numeric cell suffix should not parse')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
