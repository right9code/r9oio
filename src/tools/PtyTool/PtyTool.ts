import { z } from 'zod/v4'

import { isPtyAvailable, ptyRun } from '../../services/pty/pty.js'
import type { Tool } from '../../Tool.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { getCwd } from '../../utils/cwd.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { lazySchema } from '../../utils/lazySchema.js'

import { DESCRIPTION, PTY_TOOL_NAME, PTY_TOOL_PROMPT } from './prompt.js'
import { renderToolResultMessage, renderToolUseMessage } from './UI.js'

const MAX_TIMEOUT_MS = 600_000

const inputSchema = lazySchema(() =>
  z.strictObject({
    command: z
      .string()
      .min(1)
      .describe(
        'Shell command to run inside the PTY. A fresh shell is spawned; an automatic "exit" is appended so the shell terminates after the command.',
      ),
    cwd: z
      .string()
      .optional()
      .describe('Working directory. Defaults to the current cwd.'),
    timeoutMs: z
      .number()
      .int()
      .min(100)
      .max(MAX_TIMEOUT_MS)
      .optional()
      .describe(
        `Kill the PTY after this many ms. Default 30000, max ${MAX_TIMEOUT_MS}.`,
      ),
    cols: z
      .number()
      .int()
      .min(20)
      .max(500)
      .optional()
      .describe('Terminal width in columns. Default 120.'),
    rows: z
      .number()
      .int()
      .min(5)
      .max(200)
      .optional()
      .describe('Terminal height in rows. Default 30.'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    ok: z.boolean(),
    output: z.string(),
    exitCode: z.number().nullable(),
    signal: z.union([z.string(), z.number()]).nullable(),
    timedOut: z.boolean(),
    aborted: z.boolean(),
    truncated: z.boolean(),
    durationMs: z.number(),
    message: z.string().optional(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

export const PtyTool: Tool<InputSchema, Output> = buildTool({
  name: PTY_TOOL_NAME,
  searchHint: 'run a command inside a real pseudoterminal',
  maxResultSizeChars: 1_048_576,
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return PTY_TOOL_PROMPT
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName() {
    return 'Running in PTY'
  },
  isEnabled() {
    // Default OFF. Opt in with TAU_PTY_ENABLE=1. Always require node-pty
    // to actually be installed — if the optional native dep failed to build
    // the tool stays hidden so the model never offers a non-functional tool.
    return isEnvTruthy(process.env.TAU_PTY_ENABLE) && isPtyAvailable()
  },
  isReadOnly() {
    // PTY runs arbitrary shell commands — never safe to assume read-only.
    return false
  },
  isConcurrencySafe() {
    return false
  },
  toAutoClassifierInput(input) {
    return input.command
  },
  renderToolUseMessage,
  renderToolResultMessage,
  async validateInput(input, _ctx) {
    if (!isPtyAvailable()) {
      return {
        result: false,
        message:
          'PTY support is not available in this build. node-pty is an optional native dependency and was not installed (likely because the native build failed). Install build tools and reinstall to enable.',
        errorCode: 1,
      }
    }
    if (input.command.trim() === '') {
      return { result: false, message: 'command must not be empty', errorCode: 2 }
    }
    return { result: true }
  },
  async call(input, ctx) {
    const result = await ptyRun({
      command: input.command,
      cwd: input.cwd ?? getCwd(),
      timeoutMs: input.timeoutMs,
      cols: input.cols,
      rows: input.rows,
      signal: ctx.abortController.signal,
    })
    return {
      data: {
        ok: result.ok,
        output: result.output,
        exitCode: result.exitCode,
        signal: result.signal,
        timedOut: result.timedOut,
        aborted: result.aborted,
        truncated: result.truncated,
        durationMs: result.durationMs,
        ...(result.message ? { message: result.message } : {}),
      },
    }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    const flags: string[] = []
    if (output.timedOut) flags.push('timed out')
    if (output.aborted) flags.push('aborted')
    if (output.truncated) flags.push('output truncated at limit')
    const status =
      output.exitCode === null
        ? `signal=${output.signal ?? 'unknown'}`
        : `exit=${output.exitCode}`
    const header = `[pty ${status} in ${output.durationMs}ms${flags.length ? `; ${flags.join('; ')}` : ''}]`
    const body = output.output || '(no output)'
    const errMsg = output.message ? `\nerror: ${output.message}` : ''
    return {
      type: 'tool_result',
      content: `${header}\n${body}${errMsg}`,
      tool_use_id: toolUseID,
      is_error: !output.ok ? true : undefined,
    }
  },
} satisfies ToolDef<InputSchema, Output>)
