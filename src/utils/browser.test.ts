/**
 * Windows browser-open escaping regression tests.
 *
 * cmd.exe splits an unquoted `start` target at every & | < >, which
 * truncated OAuth URLs at the first "&" (Google: "Required parameter is
 * missing: response_type"). escapeForCmdStart must caret-escape unquoted
 * targets and leave whitespace-containing targets (which the spawn arg
 * serializer wraps in quotes) untouched.
 *
 * Run: bun run src/utils/browser.test.ts
 */

import { escapeForCmdStart } from './browser.js'
import { buildAuthorizationUrl, generatePKCE } from '../lanes/shared/antigravity_auth.js'

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

/** What cmd.exe hands to `start` after parsing an unquoted escaped tail. */
function simulateCmdParse(arg: string): string {
  return arg.replace(/\^(.)/g, '$1')
}

function main(): void {
  console.log('escapeForCmdStart:')

  test('caret-escapes every cmd metacharacter in a bare target', () => {
    assertEqual(
      escapeForCmdStart('https://x.test/?a=1&b=2|c<d>e^f'),
      'https://x.test/?a=1^&b=2^|c^<d^>e^^f',
      'each of & | < > ^ must be caret-escaped',
    )
  })

  test('leaves whitespace-containing targets untouched (spawn quotes those)', () => {
    const path = 'C:\\Program Files\\my & app\\readme.txt'
    assertEqual(escapeForCmdStart(path), path, 'quoted targets must not gain carets')
  })

  test('antigravity auth URL survives cmd parsing intact', () => {
    const url = buildAuthorizationUrl({ pkce: generatePKCE() })
    const parsed = simulateCmdParse(escapeForCmdStart(url))
    assertEqual(parsed, url, 'cmd must deliver the full authorization URL to start')
  })

  test('antigravity auth URL keeps response_type after escaping', () => {
    const url = buildAuthorizationUrl({ pkce: generatePKCE() })
    const escaped = escapeForCmdStart(url)
    assertEqual(
      escaped.includes('^&response_type=code'),
      true,
      'response_type must be caret-protected, not a cmd command separator',
    )
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main()
