/**
 * Grep flood grouping checks.
 *
 * Run via: bun run src/tools/GrepTool/groupFlood.test.ts
 */

import { buildGroupedGrepSummary, parseGrepContentLine } from './groupFlood.js'

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

const identity = (p: string) => p

function lines(spec: Array<[file: string, count: number]>): string[] {
  const out: string[] = []
  for (const [file, count] of spec) {
    for (let i = 1; i <= count; i++) {
      out.push(`${file}:${i * 10}:  const value = ${i}`)
    }
  }
  return out
}

console.log('parseGrepContentLine:')

test('plain posix line parses', () => {
  const parsed = parseGrepContentLine('src/a.ts:42:  foo()')
  assert(parsed?.path === 'src/a.ts', String(parsed?.path))
  assert(parsed?.lineNumber === 42, String(parsed?.lineNumber))
})

test('windows absolute path keeps drive letter in path', () => {
  const parsed = parseGrepContentLine('C:\\Users\\ok\\src\\a.ts:7:let x = 1')
  assert(parsed?.path === 'C:\\Users\\ok\\src\\a.ts', String(parsed?.path))
  assert(parsed?.lineNumber === 7, String(parsed?.lineNumber))
})

test('content containing colon-digits pairs still splits at the first one after the path', () => {
  const parsed = parseGrepContentLine('src/a.ts:5:see other match at b.ts:99:here')
  assert(parsed?.path === 'src/a.ts', String(parsed?.path))
  assert(parsed?.lineNumber === 5, String(parsed?.lineNumber))
})

test('line without a line number does not parse', () => {
  assert(parseGrepContentLine('src/a.ts:no numbers here') === null, 'expected null')
  assert(parseGrepContentLine('random text') === null, 'expected null')
})

console.log('\nbuildGroupedGrepSummary:')

test('under the limit returns null', () => {
  const result = buildGroupedGrepSummary(lines([['a.ts', 10]]), 250, identity)
  assert(result === null, 'expected null')
})

test('marginal overflow in few files returns null (flat slice reads better)', () => {
  // 260 lines at limit 250 across 2 files: not flooded enough.
  const result = buildGroupedGrepSummary(
    lines([
      ['a.ts', 130],
      ['b.ts', 130],
    ]),
    250,
    identity,
  )
  assert(result === null, 'expected null')
})

test('real flood groups by file with counts sorted desc', () => {
  const result = buildGroupedGrepSummary(
    lines([
      ['small.ts', 20],
      ['big.ts', 300],
      ['mid.ts', 120],
    ]),
    250,
    identity,
  )
  assert(result !== null, 'expected grouping')
  assert(result!.numLines === 440, String(result!.numLines))
  assert(result!.numFiles === 3, String(result!.numFiles))
  const bigIdx = result!.content.indexOf('big.ts — 300 matches')
  const midIdx = result!.content.indexOf('mid.ts — 120 matches')
  const smallIdx = result!.content.indexOf('small.ts — 20 matches')
  assert(bigIdx >= 0 && midIdx > bigIdx && smallIdx > midIdx, result!.content.slice(0, 400))
})

test('moderate overflow across many files still groups', () => {
  // 6 files x 50 = 300 at limit 250: under FLOOD_FACTOR but ≥ 4 files.
  const result = buildGroupedGrepSummary(
    lines([
      ['a.ts', 50],
      ['b.ts', 50],
      ['c.ts', 50],
      ['d.ts', 50],
      ['e.ts', 50],
      ['f.ts', 50],
    ]),
    250,
    identity,
  )
  assert(result !== null, 'expected grouping')
  assert(result!.numFiles === 6, String(result!.numFiles))
})

test('anchor list is capped with ellipsis', () => {
  const result = buildGroupedGrepSummary(
    lines([
      ['big.ts', 400],
      ['b.ts', 2],
      ['c.ts', 2],
      ['d.ts', 2],
    ]),
    250,
    identity,
  )
  assert(result !== null, 'expected grouping')
  const line = result!.content.split('\n').find(l => l.startsWith('big.ts'))
  assert(line !== undefined, 'missing big.ts line')
  assert(line!.includes(', …'), line!)
  // 12 anchors max: count commas (11 separators + ellipsis marker)
  const anchors = line!.slice(line!.indexOf('(lines ') + 7).split(',')
  assert(anchors.length === 13, String(anchors.length)) // 12 anchors + '…)'
})

test('file list is capped with an omitted-files tail', () => {
  const spec: Array<[string, number]> = []
  for (let i = 0; i < 60; i++) {
    spec.push([`file${String(i).padStart(2, '0')}.ts`, 10])
  }
  const result = buildGroupedGrepSummary(lines(spec), 250, identity)
  assert(result !== null, 'expected grouping')
  assert(result!.content.includes('… and 20 more files (200 matches)'), result!.content.slice(-200))
})

test('relativize is applied to displayed paths', () => {
  const result = buildGroupedGrepSummary(
    lines([
      ['C:\\repo\\a.ts', 200],
      ['C:\\repo\\b.ts', 200],
      ['C:\\repo\\c.ts', 200],
      ['C:\\repo\\d.ts', 200],
    ]),
    250,
    p => p.replace('C:\\repo\\', ''),
  )
  assert(result !== null, 'expected grouping')
  assert(result!.content.includes('\na.ts — 200 matches'), result!.content.slice(0, 300))
  assert(!result!.content.includes('C:\\repo'), 'paths were not relativized')
})

test('mostly-unparseable output falls back to null', () => {
  const junk = Array.from({ length: 400 }, (_, i) => `binary blob ${i}`)
  const result = buildGroupedGrepSummary(junk, 250, identity)
  assert(result === null, 'expected null')
})

test('deterministic: same input gives byte-identical output', () => {
  const input = lines([
    ['x.ts', 300],
    ['y.ts', 150],
  ])
  const a = buildGroupedGrepSummary(input, 250, identity)
  const b = buildGroupedGrepSummary(input, 250, identity)
  assert(a !== null && b !== null, 'expected grouping')
  assert(a!.content === b!.content, 'outputs differ')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
