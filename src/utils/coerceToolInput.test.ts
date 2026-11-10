/**
 * Tool input coercion invariants.
 *
 * Run: bun run src/utils/coerceToolInput.test.ts
 */

import { z } from 'zod/v4'
import { coerceToolInput } from './coerceToolInput.js'

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

function main(): void {
  console.log('tool input coercion:')

  test('drops null optional/defaulted fields before Zod validation', () => {
    const schema = z.object({
      taskId: z.string(),
      subject: z.string().optional(),
      priority: z.number().default(1),
    })

    const out = coerceToolInput({
      taskId: 'task-1',
      subject: null,
      priority: null,
    }, schema)

    assert(out.taskId === 'task-1', 'required value preserved')
    assert(!('subject' in out), 'optional null should be omitted')
    assert(!('priority' in out), 'defaulted null should be omitted')
    assert(schema.safeParse(out).success, 'coerced input should pass')
  })

  test('keeps null required fields so validation can reject them', () => {
    const schema = z.object({ taskId: z.string() })
    const out = coerceToolInput({ taskId: null }, schema)
    assert('taskId' in out && out.taskId === null, 'required null must not be hidden')
    assert(!schema.safeParse(out).success, 'required null should still fail')
  })

  const editSchema = z.object({
    file_path: z.string(),
    old_string: z.string(),
    new_string: z.string(),
  })

  test('recovers _raw with an under-escaped Windows path (invalid JSON escapes)', () => {
    // Single backslashes in the path -> \U \o \a are invalid JSON escapes, so a
    // compat lane could not JSON.parse the args and set the _raw sentinel.
    const raw =
      '{"file_path": "C:\\Users\\ok\\arithmetic.rb", "old_string": "puts \\"mul\\"", "new_string": "puts \\"mul\\"\\nputs \\"mod\\""}'
    const out = coerceToolInput({ _raw: raw }, editSchema)
    assert(!('_raw' in out), '_raw sentinel should be unwrapped')
    assert(
      out.file_path === 'C:\\Users\\ok\\arithmetic.rb',
      'path recovered with literal backslashes',
    )
    assert(out.old_string === 'puts "mul"', 'old_string recovered')
    assert(
      out.new_string === 'puts "mul"\nputs "mod"',
      'new_string recovered (escaped quotes + newline)',
    )
    assert(editSchema.safeParse(out).success, 'recovered input should pass Edit validation')
  })

  test('leaves _raw when the JSON is truncated so validation rejects (no partial write)', () => {
    const raw = '{"file_path": "C:\\Users\\ok\\a.rb", "old_string": "puts \\"mul'
    const out = coerceToolInput({ _raw: raw }, editSchema)
    assert('_raw' in out, 'truncated call must not be force-completed')
    assert(!editSchema.safeParse(out).success, 'truncated _raw should still fail validation')
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main()
