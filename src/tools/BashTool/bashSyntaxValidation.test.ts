/**
 * Bash syntax validation unit tests.
 *
 * Run: bun run src/tools/BashTool/bashSyntaxValidation.test.ts
 */

import {
  formatBashSyntaxValidationError,
  getBashSyntaxCorrectionHints,
  validateBashSyntax,
} from './bashSyntaxValidation.js'

let passed = 0
let failed = 0

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
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

async function main(): Promise<void> {
  console.log('bash syntax validation:')

  await test('formats parser failures as non-execution guidance', () => {
    const message = formatBashSyntaxValidationError(
      'echo "unterminated',
      "bash: -c: line 1: unexpected EOF while looking for matching `\"'",
    )

    assert(
      message.includes('Bash syntax validation failed before execution.'),
      'missing pre-execution failure header',
    )
    assert(
      message.includes('The command was not executed.'),
      'missing non-execution statement',
    )
    assert(
      message.includes('Close any open quote'),
      'missing corrective quote guidance',
    )
  })

  await test('detects PowerShell-looking Bash input', () => {
    const hints = getBashSyntaxCorrectionHints(
      'Get-ChildItem $env:USERPROFILE | Select-String foo',
      'syntax error',
    )

    assert(
      hints.some(hint => hint.includes('PowerShell syntax')),
      'missing PowerShell syntax hint',
    )
  })

  await test('accepts valid Bash without executing it', async () => {
    const result = await validateBashSyntax('echo ok')

    assert(
      result.ok,
      `expected valid Bash to pass; got ${result.ok ? 'ok' : result.message}`,
    )
  })

  await test('rejects malformed Bash before execution', async () => {
    const result = await validateBashSyntax('echo "unterminated')

    assert(!result.ok, 'expected malformed Bash to fail validation')
    assert(
      !result.ok &&
        result.message.includes('Bash syntax validation failed before execution.'),
      'missing syntax validation failure message',
    )
    assert(
      !result.ok && result.message.includes('The command was not executed.'),
      'missing non-execution statement',
    )
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main()
