import { formatPatch, structuredPatch } from 'diff'
import { resolve } from 'path'
import { z } from 'zod/v4'

import type { Tool } from '../../Tool.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { getCwd } from '../../utils/cwd.js'
import { readFileSafe } from '../../utils/file.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { renderToolResultMessage, renderToolUseMessage } from './UI.js'

export const FILE_DIFF_TOOL_NAME = 'FileDiff'

// Combined before+after byte ceiling. Past this the visual diff is more noise
// than signal (and slow to render), so we return a summary instead.
const MAX_DIFF_BYTES = 256 * 1024

const DESCRIPTION =
  'Show a visual, syntax-highlighted diff between two files. Read-only — never modifies either file.'

const PROMPT = `Render a unified, color diff between two files (\`fileA\` = base/left, \`fileB\` = compare/right). Read-only.

When to use:
- The user asks to compare or diff two files, or to see what changed between two versions kept as separate files.
- Prefer this over running \`diff\` in the shell — the output is syntax-highlighted, word-level, and rendered in the UI.

Inputs:
- \`fileA\` (required): path to the base/left file (absolute or relative to the working directory).
- \`fileB\` (required): path to the compare/right file.

Notes:
- A "-" line is content in fileA that fileB lacks; a "+" line is content fileB adds. In-place edits are highlighted at the word level (yellow).
- If a file can't be read, the result names the failing path.`

const inputSchema = lazySchema(() =>
  z.strictObject({
    fileA: z
      .string()
      .describe('Path to the base/left file (absolute or cwd-relative).'),
    fileB: z
      .string()
      .describe('Path to the compare/right file (absolute or cwd-relative).'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    ok: z.boolean(),
    summary: z.string(),
    fileA: z.string().optional(),
    fileB: z.string().optional(),
    patch: z.string().optional(),
    additions: z.number().optional(),
    deletions: z.number().optional(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

export const FileDiffTool: Tool<InputSchema, Output> = buildTool({
  name: FILE_DIFF_TOOL_NAME,
  searchHint: 'diff two files visually',
  maxResultSizeChars: 500_000,
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return PROMPT
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName() {
    return 'Diffing files'
  },
  isReadOnly() {
    return true
  },
  isConcurrencySafe() {
    return true
  },
  isDestructive() {
    return false
  },
  toAutoClassifierInput(input) {
    return `${input.fileA ?? ''} ${input.fileB ?? ''}`.trim()
  },
  async validateInput(input) {
    if (!input.fileA?.trim() || !input.fileB?.trim()) {
      return {
        result: false,
        message: 'FileDiff requires both "fileA" and "fileB"',
        errorCode: 1,
      }
    }
    return { result: true }
  },
  renderToolUseMessage,
  renderToolResultMessage,
  async call(input) {
    const cwd = getCwd()
    const a = readFileSafe(resolve(cwd, input.fileA))
    const b = readFileSafe(resolve(cwd, input.fileB))

    if (a === null || b === null) {
      const missing = [
        a === null ? input.fileA : null,
        b === null ? input.fileB : null,
      ]
        .filter(Boolean)
        .join(', ')
      return { data: { ok: false, summary: `Cannot read file(s): ${missing}` } }
    }

    if (a === b) {
      return {
        data: {
          ok: true,
          summary: 'Files are identical',
          fileA: input.fileA,
          fileB: input.fileB,
          patch: '',
          additions: 0,
          deletions: 0,
        },
      }
    }

    if (a.length + b.length > MAX_DIFF_BYTES) {
      return {
        data: {
          ok: true,
          summary: `Files too large to diff visually (${a.length + b.length} bytes > ${MAX_DIFF_BYTES})`,
          fileA: input.fileA,
          fileB: input.fileB,
        },
      }
    }

    const sp = structuredPatch(input.fileA, input.fileB, a, b, '', '')
    const patch = formatPatch(sp)
    const additions = sp.hunks.reduce(
      (n, h) => n + h.lines.filter(l => l.startsWith('+')).length,
      0,
    )
    const deletions = sp.hunks.reduce(
      (n, h) => n + h.lines.filter(l => l.startsWith('-')).length,
      0,
    )

    return {
      data: {
        ok: true,
        summary: `${input.fileA} → ${input.fileB}  +${additions} -${deletions}`,
        fileA: input.fileA,
        fileB: input.fileB,
        patch,
        additions,
        deletions,
      },
    }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    const content =
      output.ok && output.patch && output.patch.trim() !== ''
        ? output.patch
        : output.summary
    return {
      type: 'tool_result',
      content,
      tool_use_id: toolUseID,
      is_error: output.ok ? undefined : true,
    }
  },
} satisfies ToolDef<InputSchema, Output>)
