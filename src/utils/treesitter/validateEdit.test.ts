/**
 * Smoke tests for the tree-sitter edit-syntax validator.
 * Run via `bun run src/utils/treesitter/validateEdit.test.ts`.
 *
 * Requires the web-tree-sitter + @vscode/tree-sitter-wasm dependencies (they
 * ship with tau). The validator degrades to `undefined` when parsing is
 * unavailable, so the "introduces error" cases below would fail loudly in a
 * broken environment rather than passing silently.
 */

import { validateEditSyntax } from './validateEdit.js'

let passed = 0
let failed = 0

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (e: unknown) {
    failed++
    console.log(`  FAIL ${name}: ${(e as Error)?.message ?? String(e)}`)
  }
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg)
}

await test('flags an edit that introduces a syntax error (.ts)', async () => {
  const w = await validateEditSyntax('foo.ts', 'const x = 1\n', 'const x = (\n')
  assert(typeof w === 'string', `expected a warning, got ${JSON.stringify(w)}`)
})

await test('stays silent on a clean edit (.ts)', async () => {
  const w = await validateEditSyntax('foo.ts', 'const x = 1\n', 'const x = 2\n')
  assert(w === undefined, `expected undefined, got ${JSON.stringify(w)}`)
})

await test('delta: unchanged pre-existing errors do NOT warn', async () => {
  // before is already broken; after has the same error count -> not introduced.
  const broken = 'function f( {\n'
  const w = await validateEditSyntax('foo.ts', broken, broken)
  assert(w === undefined, `expected undefined, got ${JSON.stringify(w)}`)
})

await test('skips unsupported extensions', async () => {
  const w = await validateEditSyntax('notes.txt', 'a', 'b (')
  assert(w === undefined, `expected undefined, got ${JSON.stringify(w)}`)
})

await test('flags a broken new file (.tsx)', async () => {
  const w = await validateEditSyntax('new.tsx', '', '<App attr=\n')
  assert(typeof w === 'string', `expected a warning, got ${JSON.stringify(w)}`)
})

await test('flags a broken edit (.py)', async () => {
  const w = await validateEditSyntax('s.py', 'x = 1\n', 'x = (\n')
  assert(typeof w === 'string', `expected a warning, got ${JSON.stringify(w)}`)
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
