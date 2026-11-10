/**
 * Correction mining checks.
 *
 * Run via: bun run src/utils/correctionMining.test.ts
 */

import {
  classifyCorrectionPair,
  extractCommandEvents,
  isFailureResult,
  mineCorrections,
  renderCorrectionsBlock,
  upsertCorrectionsBlock,
  type CommandEvent,
} from './correctionMining.js'

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

function event(
  partial: Partial<CommandEvent> & { command: string; failed: boolean },
): CommandEvent {
  return {
    sessionId: 's1',
    seq: 0,
    shell: 'bash',
    ...partial,
  }
}

console.log('isFailureResult:')

test('is_error true is a failure', () => {
  assert(isFailureResult(true, 'anything'), 'expected failure')
})

test('nonzero exit marker is a failure, exit 0 is not', () => {
  assert(isFailureResult(false, 'output\nExit code 127'), 'expected failure')
  assert(!isFailureResult(false, 'done\nExit code 0'), 'exit 0 is not failure')
  assert(!isFailureResult(undefined, 'regular output'), 'no marker = success')
})

console.log('\nclassifyCorrectionPair:')

test('venv python swap classifies as executable-swap keyed on executables', () => {
  const result = classifyCorrectionPair(
    'python scripts/build.py --fast',
    '.venv\\Scripts\\python.exe scripts/build.py --fast',
    'bash',
  )
  assert(result?.kind === 'executable-swap', String(result?.kind))
  assert(result?.failedForm === 'python', String(result?.failedForm))
  assert(result?.fixedForm === '.venv\\Scripts\\python.exe', String(result?.fixedForm))
})

test('cd prefix classifies as prefix-added', () => {
  const result = classifyCorrectionPair(
    'npm test',
    'cd frontend && npm test',
    'bash',
  )
  assert(result?.kind === 'prefix-added', String(result?.kind))
  assert(result?.fixedForm === 'cd frontend && npm test', String(result?.fixedForm))
})

test('same executable with adjusted args classifies as args-adjusted', () => {
  const result = classifyCorrectionPair(
    'jest src/foo.test.ts',
    'jest src/foo.test.ts --runInBand',
    'bash',
  )
  assert(result?.kind === 'args-adjusted', String(result?.kind))
})

test('unrelated commands do not pair', () => {
  assert(
    classifyCorrectionPair('npm test', 'ls -la', 'bash') === null,
    'expected null',
  )
  assert(
    classifyCorrectionPair('python build.py', 'git status', 'bash') === null,
    'expected null',
  )
})

test('identical commands do not pair', () => {
  assert(
    classifyCorrectionPair('npm test', 'npm  test', 'bash') === null,
    'expected null (whitespace-normalized identical)',
  )
})

console.log('\nmineCorrections:')

test('fail-then-fix within lookahead produces one rule', () => {
  const events = [
    event({ seq: 0, command: 'python run.py', failed: true, errorExcerpt: "'python' is not recognized", timestamp: '2026-07-01T10:00:00Z' }),
    event({ seq: 1, command: 'ls', failed: false }),
    event({ seq: 2, command: '.venv\\Scripts\\python.exe run.py', failed: false, timestamp: '2026-07-01T10:01:00Z' }),
  ]
  const rules = mineCorrections(events)
  assert(rules.length === 1, String(rules.length))
  assert(rules[0]!.kind === 'executable-swap', rules[0]!.kind)
  assert(rules[0]!.occurrences === 1, String(rules[0]!.occurrences))
  assert(rules[0]!.lastSeen === '2026-07-01', String(rules[0]!.lastSeen))
  assert(rules[0]!.errorHint === "'python' is not recognized", String(rules[0]!.errorHint))
})

test('same swap across sessions aggregates occurrences', () => {
  const events = [
    event({ sessionId: 'a', seq: 0, command: 'python x.py', failed: true }),
    event({ sessionId: 'a', seq: 1, command: 'py x.py', failed: false, timestamp: '2026-07-02T00:00:00Z' }),
    event({ sessionId: 'b', seq: 0, command: 'python other.py --flag', failed: true }),
    event({ sessionId: 'b', seq: 1, command: 'py other.py --flag', failed: false, timestamp: '2026-07-05T00:00:00Z' }),
  ]
  const rules = mineCorrections(events)
  assert(rules.length === 1, JSON.stringify(rules))
  assert(rules[0]!.occurrences === 2, String(rules[0]!.occurrences))
  assert(rules[0]!.lastSeen === '2026-07-05', String(rules[0]!.lastSeen))
})

test('flaky command (identical rerun succeeds) produces no rule', () => {
  const events = [
    event({ seq: 0, command: 'npm test', failed: true }),
    event({ seq: 1, command: 'npm test', failed: false }),
  ]
  assert(mineCorrections(events).length === 0, 'expected no rules')
})

test('args-adjusted needs two observations, executable-swap needs one', () => {
  const events = [
    event({ sessionId: 'a', seq: 0, command: 'jest foo.ts', failed: true }),
    event({ sessionId: 'a', seq: 1, command: 'jest foo.ts --runInBand', failed: false }),
  ]
  assert(mineCorrections(events).length === 0, 'single args-adjust should be filtered')
  const events2 = [
    ...events,
    event({ sessionId: 'b', seq: 0, command: 'jest foo.ts', failed: true }),
    event({ sessionId: 'b', seq: 1, command: 'jest foo.ts --runInBand', failed: false }),
  ]
  const rules = mineCorrections(events2)
  assert(rules.length === 1, String(rules.length))
})

test('fix beyond lookahead window is not paired', () => {
  const events = [
    event({ seq: 0, command: 'python run.py', failed: true }),
    ...Array.from({ length: 6 }, (_, i) =>
      event({ seq: i + 1, command: `echo step${i}`, failed: false }),
    ),
    event({ seq: 7, command: 'py run.py', failed: false }),
  ]
  assert(mineCorrections(events).length === 0, 'expected no rules')
})

console.log('\nextractCommandEvents:')

test('pairs tool_use with tool_result and detects failure', () => {
  const lines = [
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-07-01T10:00:00Z',
      message: {
        content: [
          { type: 'tool_use', id: 'u1', name: 'Bash', input: { command: 'python x.py' } },
        ],
      },
    }),
    JSON.stringify({
      type: 'user',
      timestamp: '2026-07-01T10:00:05Z',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'u1', is_error: true, content: "'python' is not recognized as an internal or external command" },
        ],
      },
    }),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-07-01T10:00:10Z',
      message: {
        content: [
          { type: 'tool_use', id: 'u2', name: 'Bash', input: { command: 'py x.py' } },
        ],
      },
    }),
    JSON.stringify({
      type: 'user',
      timestamp: '2026-07-01T10:00:15Z',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'u2', content: 'done' }],
      },
    }),
  ]
  const events = extractCommandEvents(lines, 'sess')
  assert(events.length === 2, String(events.length))
  assert(events[0]!.failed === true, 'first should fail')
  assert(events[0]!.errorExcerpt?.includes('not recognized') === true, String(events[0]!.errorExcerpt))
  assert(events[1]!.failed === false, 'second should succeed')
  const rules = mineCorrections(events)
  assert(rules.length === 1 && rules[0]!.kind === 'executable-swap', JSON.stringify(rules))
})

test('sidechain lines and non-shell tools are ignored', () => {
  const lines = [
    JSON.stringify({
      type: 'assistant',
      isSidechain: true,
      message: { content: [{ type: 'tool_use', id: 's1', name: 'Bash', input: { command: 'rm -rf x' } }] },
    }),
    JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'g1', name: 'Grep', input: { pattern: 'x' } }] },
    }),
    'not json at all',
  ]
  assert(extractCommandEvents(lines, 'sess').length === 0, 'expected no events')
})

console.log('\nupsertCorrectionsBlock:')

const RULES = mineCorrections([
  event({ seq: 0, command: 'python run.py', failed: true, errorExcerpt: "'python' is not recognized", timestamp: '2026-07-01T10:00:00Z' }),
  event({ seq: 1, command: 'py run.py', failed: false, timestamp: '2026-07-01T10:01:00Z' }),
])
const BLOCK = renderCorrectionsBlock(RULES)

test('append to existing content keeps original text', () => {
  const before = '# My project\n\nSome instructions.\n'
  const after = upsertCorrectionsBlock(before, BLOCK)
  assert(after.startsWith('# My project'), after.slice(0, 40))
  assert(after.includes(BLOCK), 'block missing')
})

test('re-apply replaces in place (idempotent)', () => {
  const once = upsertCorrectionsBlock('# P\n', BLOCK)
  const twice = upsertCorrectionsBlock(once, BLOCK)
  assert(once === twice, 'not idempotent')
})

test('clear removes the block and keeps the rest', () => {
  const withBlock = upsertCorrectionsBlock('# P\n\nBody text.\n', BLOCK)
  const cleared = upsertCorrectionsBlock(withBlock, null)
  assert(!cleared.includes('tau:learned-corrections'), cleared)
  assert(cleared.includes('# P'), cleared)
  assert(cleared.includes('Body text.'), cleared)
})

test('block renders the venv rule readably', () => {
  assert(BLOCK.includes('Use `py` instead of `python`'), BLOCK)
  assert(BLOCK.includes('is not recognized'), BLOCK)
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
