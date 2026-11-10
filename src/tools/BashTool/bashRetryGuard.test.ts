/**
 * Bash retry guard unit tests.
 *
 * Run: bun run src/tools/BashTool/bashRetryGuard.test.ts
 */

import {
  checkBashRetryGuard,
  extractExecutableSet,
  recordBashFailure,
  recordBashSuccess,
  resetBashRetryGuard,
} from './bashRetryGuard.js'

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    resetBashRetryGuard()
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
  console.log('bash retry guard:')

  test('extractExecutableSet returns single base for simple command', () => {
    const set = extractExecutableSet('uvicorn app.main:app --reload')
    assert(set.length === 1 && set[0] === 'uvicorn', `got ${JSON.stringify(set)}`)
  })

  test('extractExecutableSet returns sorted union for chained commands', () => {
    const set = extractExecutableSet('source .venv/Scripts/activate && uvicorn app.main:app')
    assert(set.length === 2, `expected 2 execs, got ${JSON.stringify(set)}`)
    assert(set.includes('source') && set.includes('uvicorn'), 'expected source + uvicorn')
  })

  test('extractExecutableSet strips path prefix and .exe suffix', () => {
    const set = extractExecutableSet('/usr/bin/git push && C:/bin/node.exe app.js')
    assert(set.includes('git') && set.includes('node'), `got ${JSON.stringify(set)}`)
  })

  test('extractExecutableSet skips env-var prefixes', () => {
    const set = extractExecutableSet('PYTHONIOENCODING=utf-8 python script.py')
    assert(set.length === 1 && set[0] === 'python', `got ${JSON.stringify(set)}`)
  })

  test('extractExecutableSet handles ; | || && separators', () => {
    const set = extractExecutableSet('a ; b || c && d | e')
    assert(set.length === 5, `expected 5 distinct execs, got ${JSON.stringify(set)}`)
  })

  test('per-signature: repeated failures never block execution', () => {
    recordBashFailure('false', 1, '')
    assert(checkBashRetryGuard('false') === null, 'first retry allowed')
    recordBashFailure('false', 1, '')
    assert(checkBashRetryGuard('false') === null, 'second retry must also be allowed')
  })

  test('per-signature: distinguishes same command in different cwd', () => {
    recordBashFailure('npm test', 1, '', '/repo')
    recordBashFailure('npm test', 1, '', '/repo')

    assert(
      checkBashRetryGuard('npm test', '/repo/backend') === null,
      'same command in a different cwd should be allowed',
    )

    assert(
      checkBashRetryGuard('npm test', '/repo') === null,
      'same command in the same cwd must remain runnable',
    )
  })

  test('per-intent: variants remain diagnostic-only', () => {
    // Simulate the transcript: same source+uvicorn chain, different paths.
    recordBashFailure('source /c/Users/a/.venv/Scripts/activate && uvicorn app:app', 1, 'err1')
    recordBashFailure('source .venv/Scripts/activate && uvicorn app.main:app --port 8000', 1, 'err2')
    assert(
      checkBashRetryGuard('source other/.venv/Scripts/activate && uvicorn app:app --reload') === null,
      'third distinct variant should not yet be blocked (we check BEFORE record)',
    )
    recordBashFailure('source other/.venv/Scripts/activate && uvicorn app:app --reload', 1, 'err3')
    assert(
      checkBashRetryGuard('source /tmp/.venv/Scripts/activate && uvicorn server:app') === null,
      'fourth attempt must remain runnable',
    )
  })

  test('per-intent: legitimate single-tool variations do NOT trigger if exact-commands repeat', () => {
    // Three exact retries of `npm install foo` count as 1 distinct command —
    // intent tracker keeps a SET, not a count, so this is per-signature only.
    recordBashFailure('npm install foo', 1, 'e')
    recordBashFailure('npm install foo', 1, 'e')
    recordBashFailure('npm install foo', 1, 'e')
    // Per-signature should block (3 attempts), but intent tracker has only 1
    // distinct command. Check intent specifically by querying a NEW intent-matching cmd.
    const block = checkBashRetryGuard('npm install bar')
    // 2 distinct commands (`npm install foo`, `npm install bar` after this check) —
    // shouldn't trip intent threshold of 3 distinct yet, and `npm install bar` is a
    // fresh signature, so it should be allowed.
    assert(block === null, `npm install bar should be allowed, got: ${block}`)
  })

  test('per-intent: three distinct npm-family failures do not block', () => {
    recordBashFailure('npm install foo', 1, 'e')
    recordBashFailure('npm install bar', 1, 'e')
    recordBashFailure('npm install baz', 1, 'e')
    assert(
      checkBashRetryGuard('npm install qux') === null,
      'fourth npm install variant must remain runnable',
    )
  })

  test('intent tracker cleared by overlapping-exe success', () => {
    recordBashFailure('uvicorn a:a', 1, 'e')
    recordBashFailure('uvicorn b:b --port 8000', 1, 'e')
    recordBashFailure('uvicorn c:c --reload', 1, 'e')
    // Success on a command sharing the uvicorn executable should clear intent.
    recordBashSuccess('uvicorn app:app --port 9000')
    const block = checkBashRetryGuard('uvicorn d:d')
    assert(block === null, `intent should be cleared by success, got: ${block}`)
  })

  test('diagnostic command clears all trackers', () => {
    recordBashFailure('source x && uvicorn a:a', 1, 'e')
    recordBashFailure('source y && uvicorn b:b', 1, 'e')
    recordBashFailure('source z && uvicorn c:c', 1, 'e')
    recordBashSuccess('ls -la')
    const block = checkBashRetryGuard('source w && uvicorn d:d')
    assert(block === null, `ls (diagnostic) should clear intent tracker, got: ${block}`)
  })

  test('reset clears all state', () => {
    recordBashFailure('false', 1, '')
    recordBashFailure('false', 1, '')
    resetBashRetryGuard()
    assert(checkBashRetryGuard('false') === null, 'reset should clear failures')
  })

  // ── wrong-directory loop escape ────────────────────────────────
  // The transcript bug: `dvc repro` run in the wrong root fails twice, gets
  // blocked, and the model loops because nothing points it at an explicit
  // absolute project location.
  test('repeated project-tool failures do not expose a block message', () => {
    recordBashFailure('dvc repro', 253, "ERROR: 'dvc.yaml' does not exist")
    recordBashFailure('dvc repro', 253, "ERROR: 'dvc.yaml' does not exist")
    assert(checkBashRetryGuard('dvc repro') === null, 'repeated bare command must run')
  })

  test('same command with a different absolute location remains runnable', () => {
    recordBashFailure('dvc repro', 253, 'err')
    recordBashFailure('dvc repro', 253, 'err')
    assert(checkBashRetryGuard('dvc repro') === null, 'bare repeat remains runnable')
    assert(
      checkBashRetryGuard('dvc repro', '/c/Users/ok/Desktop/real-dvc-project') === null,
      'targeting a different absolute location is a new attempt and must be allowed',
    )
  })

  test('a failure under one workdir does not block a different workdir', () => {
    recordBashFailure('dvc repro', 253, 'err', '/c/wrong')
    recordBashFailure('dvc repro', 253, 'err', '/c/wrong')
    assert(checkBashRetryGuard('dvc repro', '/c/wrong') === null, 'same workdir remains runnable')
    assert(checkBashRetryGuard('dvc repro', '/c/right') === null, 'different workdir → allowed')
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main()
