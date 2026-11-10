/**
 * Run: bun run src/utils/toolResultStorage.test.ts
 */

import { join } from 'path'
import {
  getProjectTempDirForTauOutputPaths,
  isAllowedTauManagedTaskOutputPath,
} from './tauManagedOutputPaths.js'

let passed = 0
let failed = 0

async function test(
  name: string,
  fn: () => void | Promise<void>,
): Promise<void> {
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

console.log('tool result storage:')

await test('allows Tau task output files under project temp sessions', async () => {
  const originalCwd = process.cwd()
  const projectTempDir = getProjectTempDirForTauOutputPaths(originalCwd)
  const path = join(projectTempDir, 'test-session', 'tasks', 'task-1.output')

  assert(
    isAllowedTauManagedTaskOutputPath(path, originalCwd),
    'task output path should be allowed',
  )
})

await test('rejects non-task-output files in project temp space', async () => {
  const originalCwd = process.cwd()
  const projectTempDir = getProjectTempDirForTauOutputPaths(originalCwd)

  assert(
    !isAllowedTauManagedTaskOutputPath(
      join(projectTempDir, 'test-session', 'tasks', 'task-1.txt'),
      originalCwd,
    ),
    'wrong extension should be rejected',
  )
  assert(
    !isAllowedTauManagedTaskOutputPath(
      join(projectTempDir, 'test-session', 'scratchpad', 'task-1.output'),
      originalCwd,
    ),
    'wrong subdirectory should be rejected',
  )
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
