/**
 * Builtin import verification unit tests.
 *
 * Run: bun run src/utils/importCheck.test.ts
 */

import { validateBuiltinImports } from './importCheck.js'

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

const FILE = '/repo/src/app.ts'

console.log('validateBuiltinImports:')

test('flags a name imported from the wrong builtin and suggests the right one', () => {
  const w = validateBuiltinImports(
    FILE,
    '',
    `import { join, fileURLToPath } from "node:path"\n`,
  )
  assert(w !== undefined, 'expected a warning')
  assert(w!.includes("'fileURLToPath'"), `should name the import: ${w}`)
  assert(w!.includes("'node:path'"), `should name the wrong module: ${w}`)
  assert(w!.includes("'node:url'"), `should suggest node:url: ${w}`)
})

test('valid named imports stay silent', () => {
  const w = validateBuiltinImports(
    FILE,
    '',
    `import { join, dirname } from 'node:path'\nimport { fileURLToPath } from 'node:url'\n`,
  )
  assert(w === undefined, `expected silence, got: ${w}`)
})

test('unprefixed builtin specifiers are checked too', () => {
  const w = validateBuiltinImports(FILE, '', `import { nope123 } from 'path'\n`)
  assert(w !== undefined, 'expected a warning for bare specifier')
  assert(w!.includes("'nope123'"), `should name the import: ${w}`)
})

test('pre-existing wrong imports do not nag (delta principle)', () => {
  const src = `import { fileURLToPath } from 'node:path'\n`
  const w = validateBuiltinImports(FILE, src, `${src}const x = 1\n`)
  assert(w === undefined, `expected silence for pre-existing issue, got: ${w}`)
})

test('type-only imports are skipped', () => {
  const w = validateBuiltinImports(
    FILE,
    '',
    `import type { NotAThing } from 'node:path'\nimport { type AlsoNot, join } from 'node:path'\n`,
  )
  assert(w === undefined, `expected silence for type imports, got: ${w}`)
})

test('aliased imports check the original name', () => {
  const ok = validateBuiltinImports(
    FILE,
    '',
    `import { join as j } from 'node:path'\n`,
  )
  assert(ok === undefined, `alias of valid name must pass, got: ${ok}`)
  const bad = validateBuiltinImports(
    FILE,
    '',
    `import { zzzNope as j } from 'node:path'\n`,
  )
  assert(bad !== undefined, 'alias of invalid name must warn')
})

test('require destructuring is checked, including renames', () => {
  const w = validateBuiltinImports(
    FILE,
    '',
    `const { zzzNope: alias } = require('node:path')\n`,
  )
  assert(w !== undefined, 'expected a warning for require destructure')
  assert(w!.includes("'zzzNope'"), `should name the source key: ${w}`)
})

test('export-from re-exports are checked', () => {
  const w = validateBuiltinImports(
    FILE,
    '',
    `export { zzzNope } from 'node:path'\n`,
  )
  assert(w !== undefined, 'expected a warning for export-from')
})

test('third-party modules are never loaded or flagged', () => {
  const w = validateBuiltinImports(
    FILE,
    '',
    `import { definitelyNotReal } from 'some-npm-package'\n`,
  )
  assert(w === undefined, `expected silence for non-builtin, got: ${w}`)
})

test('non-JS files and declaration files are skipped', () => {
  const src = `import { fileURLToPath } from 'node:path'\n`
  assert(
    validateBuiltinImports('/x/readme.md', '', src) === undefined,
    'markdown skipped',
  )
  assert(
    validateBuiltinImports('/x/types.d.ts', '', src) === undefined,
    'declaration file skipped',
  )
})

test('commented-out imports are ignored', () => {
  const w = validateBuiltinImports(
    FILE,
    '',
    `// import { zzzNope } from 'node:path'\n/*\nimport { alsoNope } from 'node:url'\n*/\nconst ok = 1\n`,
  )
  assert(w === undefined, `expected silence for comments, got: ${w}`)
})

test('multi-line import statements are parsed', () => {
  const w = validateBuiltinImports(
    FILE,
    '',
    `import {\n  join,\n  zzzNope,\n} from 'node:path'\n`,
  )
  assert(w !== undefined, 'expected a warning from multi-line import')
  assert(w!.includes("'zzzNope'"), `should name the import: ${w}`)
})

test('default and namespace imports are never flagged', () => {
  const w = validateBuiltinImports(
    FILE,
    '',
    `import path from 'node:path'\nimport * as url from 'node:url'\n`,
  )
  assert(w === undefined, `expected silence, got: ${w}`)
})

test('unknown/experimental builtins resolve to silence, never a crash', () => {
  const w = validateBuiltinImports(
    FILE,
    '',
    `import { whatever } from 'node:definitely_not_a_module'\n`,
  )
  assert(w === undefined, `expected silence, got: ${w}`)
})

test('the exact incident: fileURLToPath from node:path in a test file', () => {
  const before = `import { join } from "node:path"\n`
  const after = `import { join, fileURLToPath } from "node:path"\n`
  const w = validateBuiltinImports(
    '/repo/packages/httpapi-codegen/test/generate.test.ts',
    before,
    after,
  )
  assert(w !== undefined, 'must catch the incident case')
  assert(w!.includes("'node:url'"), `must point to node:url: ${w}`)
})

console.log('')
console.log(`${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
