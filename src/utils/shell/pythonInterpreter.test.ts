/**
 * Tests for Windows python3/pip3 normalization.
 * Run via `bun run src/utils/shell/pythonInterpreter.test.ts`.
 *
 * The token-aware rewrite is pure and deterministic (mapping passed in), so it
 * is fully covered regardless of platform. One live case exercises the real
 * detection but adapts its assertion to whatever the host actually has.
 */

import {
  rewritePythonInterpreter,
  normalizePythonCommand,
  detectPythonRewrite,
  type PythonRewrite,
} from './pythonInterpreter.js'

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (e: unknown) {
    failed++
    console.log(`  FAIL ${name}: ${(e as Error)?.message ?? String(e)}`)
  }
}

function eq(actual: string, expected: string): void {
  if (actual !== expected) {
    throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

const MAP: PythonRewrite = { python3: 'python', pip3: 'pip' }

test('rewrites python3 at the start', () => {
  eq(rewritePythonInterpreter('python3 script.py', MAP), 'python script.py')
})

test('rewrites bare python3 (end of string)', () => {
  eq(rewritePythonInterpreter('python3', MAP), 'python')
})

test('rewrites after a pipe', () => {
  eq(rewritePythonInterpreter('cat x | python3 y', MAP), 'cat x | python y')
})

test('rewrites after && / ; and inside a subshell', () => {
  eq(rewritePythonInterpreter('cd x && python3 a.py', MAP), 'cd x && python a.py')
  eq(rewritePythonInterpreter('a; python3 b', MAP), 'a; python b')
  eq(rewritePythonInterpreter('(python3 b)', MAP), '(python b)')
})

test('rewrites python3.exe', () => {
  eq(rewritePythonInterpreter('python3.exe -V', MAP), 'python -V')
})

test('rewrites pip3', () => {
  eq(rewritePythonInterpreter('pip3 install requests', MAP), 'pip install requests')
})

test('preserves an explicit path', () => {
  eq(rewritePythonInterpreter('/usr/bin/python3 x', MAP), '/usr/bin/python3 x')
})

test('preserves a versioned name', () => {
  eq(rewritePythonInterpreter('python3.11 x', MAP), 'python3.11 x')
})

test('preserves python3 as an argument / inside quotes', () => {
  eq(rewritePythonInterpreter('which python3', MAP), 'which python3')
  eq(rewritePythonInterpreter('echo "use python3 here"', MAP), 'echo "use python3 here"')
  eq(rewritePythonInterpreter("python3 -c 'print(\"python3\")'", MAP), "python -c 'print(\"python3\")'")
})

test('null mapping leaves the command unchanged', () => {
  eq(rewritePythonInterpreter('python3 x', { python3: null, pip3: null }), 'python3 x')
})

test('supports a multi-word replacement (py -3)', () => {
  eq(rewritePythonInterpreter('python3 x', { python3: 'py -3', pip3: null }), 'py -3 x')
})

test('live: normalizePythonCommand respects platform + real detection', () => {
  const input = 'python3 -c "print(1)"'
  const out = normalizePythonCommand(input)
  if (process.platform !== 'win32') {
    eq(out, input) // canonical python3 on POSIX — never rewritten
    return
  }
  const detected = detectPythonRewrite()
  if (detected.python3) {
    eq(out, `${detected.python3} -c "print(1)"`)
  } else {
    eq(out, input) // no working replacement found -> no-op
  }
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
