/**
 * Cross-lane shell directory compatibility contract.
 *
 * Every lane that hand-rolls its built-in shell tool schema must:
 *   1. avoid advertising a directory parameter in the schema the model sees,
 *      so models use absolute paths or native CLI location flags, and
 *   2. still map legacy directory keys to the shared Bash impl's internal
 *      `workdir` field — NEVER to a `cd <dir> && <command>` prefix.
 *
 * This is the regression guard for the bug where codex's `shell` had no
 * directory param at all (the model looped on a wrong-cwd command) and
 * gemini/cursor silently rewrote the command into `cd <dir> && …`
 * (quoting-fragile + persisted the session cwd).
 *
 * Lanes that forward the canonical Anthropic `input_schema` verbatim
 * (claude, openai-compat live path, kiro, qwen, cline, kilo) already inherit
 * the BashTool/PowerShellTool model-facing schema and need no entry here.
 *
 * Run:  bun run src/lanes/shared/shell_workdir.test.ts
 */

import {
  applyShellWorkdir,
} from './shell_workdir.js'
import {
  resolveToolCall as resolveCodexToolCall,
  getCodexRegistrationByNativeName,
} from '../codex/tools.js'
import {
  resolveToolCall as resolveGeminiToolCall,
  getRegistrationByNativeName as getGeminiRegistration,
} from '../gemini/tools.js'
import {
  resolveToolCall as resolveCompatToolCall,
  getCompatRegistrationByNativeName,
} from '../openai-compat/tools.js'
import {
  resolveCursorToolCall,
  getCursorRegistrationByNativeName,
} from '../cursor/tools.js'
import type { LaneToolRegistration } from '../types.js'

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

function schemaProperties(reg: LaneToolRegistration | undefined): Record<string, unknown> {
  const schema = reg?.nativeSchema as { properties?: Record<string, unknown> } | undefined
  return schema?.properties ?? {}
}

type Resolved = { implId: string; input: Record<string, unknown> } | null

interface ShellCase {
  lane: string
  /** native tool name the model calls */
  nativeName: string
  /** the directory param name the model uses on this lane */
  dirKey: string
  /** properties block of the registration that defines the schema */
  schemaProps: () => Record<string, unknown>
  /** resolve a native tool call into shared { implId, input } */
  resolve: (args: Record<string, unknown>) => Resolved
}

const CASES: ShellCase[] = [
  {
    lane: 'codex',
    nativeName: 'shell',
    dirKey: 'workdir',
    schemaProps: () => schemaProperties(getCodexRegistrationByNativeName('shell')),
    resolve: args => resolveCodexToolCall('shell', args),
  },
  {
    lane: 'gemini',
    nativeName: 'run_shell_command',
    dirKey: 'dir_path',
    schemaProps: () => schemaProperties(getGeminiRegistration('run_shell_command')),
    resolve: args => resolveGeminiToolCall('run_shell_command', args),
  },
  {
    lane: 'cursor',
    nativeName: 'run_terminal_cmd',
    dirKey: 'cwd',
    schemaProps: () => schemaProperties(getCursorRegistrationByNativeName('run_terminal_cmd')),
    resolve: args => resolveCursorToolCall('run_terminal_cmd', args),
  },
  {
    lane: 'cursor',
    nativeName: 'Shell',
    dirKey: 'cwd',
    schemaProps: () => schemaProperties(getCursorRegistrationByNativeName('Shell')),
    resolve: args => resolveCursorToolCall('Shell', args),
  },
  {
    lane: 'cursor',
    nativeName: 'run_shell_command',
    dirKey: 'dir_path',
    schemaProps: () => schemaProperties(getCursorRegistrationByNativeName('run_shell_command')),
    resolve: args => resolveCursorToolCall('run_shell_command', args),
  },
  {
    lane: 'openai-compat',
    nativeName: 'execute_command',
    dirKey: 'workdir',
    schemaProps: () => schemaProperties(getCompatRegistrationByNativeName('execute_command')),
    resolve: args => resolveCompatToolCall('execute_command', args),
  },
]

function main(): void {
  console.log('shell directory compatibility helper:')

  test('applyShellWorkdir maps every native key alias to workdir', () => {
    for (const key of ['workdir', 'dir_path', 'cwd', 'directory']) {
      const out = applyShellWorkdir({ command: 'x' }, { [key]: '/d' })
      assert(out.workdir === '/d', `${key} should map to workdir`)
      assert(out.command === 'x', `${key} must not touch the command`)
    }
  })

  test('applyShellWorkdir prefers explicit workdir over aliases', () => {
    const out = applyShellWorkdir({ command: 'x' }, { workdir: '/win', cwd: '/lose' })
    assert(out.workdir === '/win', 'explicit workdir should win')
  })

  test('applyShellWorkdir ignores blank / missing / non-string directories', () => {
    assert(applyShellWorkdir({ command: 'x' }, {}).workdir === undefined, 'missing → no workdir')
    assert(applyShellWorkdir({ command: 'x' }, { cwd: '   ' }).workdir === undefined, 'blank → no workdir')
    assert(applyShellWorkdir({ command: 'x' }, { cwd: 42 }).workdir === undefined, 'non-string → no workdir')
  })

  console.log('\ncross-lane shell directory compatibility contract:')

  for (const c of CASES) {
    const label = `${c.lane}:${c.nativeName}`

    test(`${label} does not advertise the '${c.dirKey}' directory param`, () => {
      const props = c.schemaProps()
      assert(
        !Object.prototype.hasOwnProperty.call(props, c.dirKey),
        `schema must not expose '${c.dirKey}'; use absolute paths or native CLI location flags`,
      )
    })

    test(`${label} maps legacy ${c.dirKey} → internal workdir (no cd-prefix)`, () => {
      const resolved = c.resolve({ command: 'run-me', [c.dirKey]: '/work/dir' })
      assert(resolved != null, 'tool call did not resolve')
      assert(resolved!.implId === 'Bash', `expected Bash impl, got ${resolved!.implId}`)
      const input = resolved!.input
      assert(input.workdir === '/work/dir', `'${c.dirKey}' must map to the workdir field`)
      assert(input.command === 'run-me', 'command must be passed through untouched')
      assert(
        !String(input.command).includes('cd '),
        'command must NOT be rewritten into a cd <dir> && … prefix',
      )
    })

    test(`${label} omits workdir when no directory is given`, () => {
      const resolved = c.resolve({ command: 'run-me' })
      assert(resolved != null && resolved.input.command === 'run-me', 'plain command should resolve')
      assert(resolved!.input.workdir === undefined, 'no directory → no workdir field')
    })
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main()
