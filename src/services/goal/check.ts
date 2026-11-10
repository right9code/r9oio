import { spawn } from 'child_process'

import type { GoalCheckResult } from './types.js'

// Cap on captured output. The failing tail (errors, failed assertions) is the
// useful part and also what we feed back into the model nudge, so we keep the
// TAIL, not the head. 4k chars ≈ 1k tokens — enough signal, bounded context.
const MAX_OUTPUT_CHARS = 4_000

// Hard ceiling so a hanging check (watch mode, prompt, infinite loop) can never
// stall the query loop. A timed-out check is treated as inconclusive and pauses
// the goal rather than looping.
export const DEFAULT_CHECK_TIMEOUT_MS = 120_000

function tail(buffers: string[], max: number): string {
  const joined = buffers.join('')
  if (joined.length <= max) return joined
  return '…[truncated]\n' + joined.slice(joined.length - max)
}

/**
 * Runs the goal's check command and reports pass/fail by exit code. Pure
 * side-effect boundary: spawns a child process, never touches the conversation
 * or the model, so it has zero cache impact. Always resolves (never rejects) so
 * a spawn failure degrades to "not passed" instead of crashing the turn.
 */
export function runGoalCheck(
  command: string,
  cwd: string,
  timeoutMs: number = DEFAULT_CHECK_TIMEOUT_MS,
): Promise<GoalCheckResult> {
  return new Promise<GoalCheckResult>(resolve => {
    const chunks: string[] = []
    let settled = false
    let timedOut = false

    const child = spawn(command, {
      cwd,
      shell: true,
      windowsHide: true,
      // Detach so we can kill the whole shell + children on timeout.
      env: process.env,
    })

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      // Escalate if it ignores SIGTERM.
      setTimeout(() => child.kill('SIGKILL'), 2_000).unref()
    }, timeoutMs)
    timer.unref()

    const onData = (data: Buffer) => {
      chunks.push(data.toString())
      // Bound memory: keep only what we'll surface.
      if (chunks.length > 64) {
        const merged = tail(chunks, MAX_OUTPUT_CHARS)
        chunks.length = 0
        chunks.push(merged)
      }
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)

    const finish = (result: GoalCheckResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }

    child.on('error', err => {
      finish({
        passed: false,
        exitCode: null,
        output: `Failed to run check command: ${
          err instanceof Error ? err.message : String(err)
        }`,
        timedOut: false,
      })
    })

    child.on('close', code => {
      finish({
        passed: !timedOut && code === 0,
        exitCode: code,
        output: tail(chunks, MAX_OUTPUT_CHARS).trim(),
        timedOut,
      })
    })
  })
}
