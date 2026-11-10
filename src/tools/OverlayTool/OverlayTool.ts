import { z } from 'zod/v4'
import type { Tool } from '../../Tool.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import {
  applyOverlay,
  getOverlayStatus,
  isOverlayActive,
  listOverlayChanges,
  rejectOverlay,
  type OverlayChange,
} from '../../services/overlay/overlay.js'
import { OVERLAY_TOOL_NAME } from './constants.js'
import { getOverlayToolPrompt } from './prompt.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    action: z
      .enum(['status', 'diff', 'apply', 'reject'])
      .describe('What to do with the overlay sandbox'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    message: z.string(),
    changes: z
      .array(
        z.object({
          file: z.string(),
          status: z.enum(['added', 'deleted', 'modified']),
          binary: z.boolean(),
          additions: z.number(),
          deletions: z.number(),
          patch: z.string(),
        }),
      )
      .optional(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

type Change = OverlayChange

function summarizeChanges(changes: Change[]): string {
  const added = changes.filter(c => c.status === 'added').length
  const deleted = changes.filter(c => c.status === 'deleted').length
  const modified = changes.filter(c => c.status === 'modified').length
  return `${changes.length} pending (${added} added, ${modified} modified, ${deleted} deleted)`
}

export const OverlayTool: Tool<InputSchema, Output> = buildTool({
  name: OVERLAY_TOOL_NAME,
  searchHint: 'inspect or apply the overlay sandbox cumulative diff',
  maxResultSizeChars: 100_000,
  async description() {
    return 'Inspect and manage the overlay sandbox (status, cumulative diff, apply, reject)'
  },
  async prompt() {
    return getOverlayToolPrompt()
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName() {
    return 'Overlay sandbox'
  },
  isEnabled() {
    return isOverlayActive()
  },
  isReadOnly(input) {
    return input?.action === 'status' || input?.action === 'diff'
  },
  async call(input) {
    switch (input.action) {
      case 'status': {
        const status = await getOverlayStatus()
        return {
          data: {
            message: status.active
              ? `Overlay sandbox on — ${status.pending} pending change${status.pending === 1 ? '' : 's'}.`
              : 'Overlay sandbox off.',
          },
        }
      }
      case 'diff': {
        const changes = await listOverlayChanges()
        return {
          data: {
            message: changes.length
              ? `Overlay sandbox cumulative diff — ${summarizeChanges(changes)}.`
              : 'No pending overlay changes.',
            changes,
          },
        }
      }
      case 'apply': {
        const result = await applyOverlay()
        return {
          data: {
            message: `Applied ${result.applied} file${result.applied === 1 ? '' : 's'}, deleted ${result.deleted}. Overlay cleared and sandbox off.`,
          },
        }
      }
      case 'reject': {
        await rejectOverlay()
        return {
          data: { message: 'Rejected all pending overlay changes. Sandbox off.' },
        }
      }
    }
  },
  renderToolUseMessage(input) {
    return `Overlay sandbox: ${input.action}`
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    const parts: string[] = [output.message]
    if (output.changes?.length) {
      for (const c of output.changes) {
        parts.push(`--- ${c.file} (${c.status})`)
        parts.push(c.binary ? '    (binary file, patch omitted)' : c.patch)
      }
    }
    return {
      type: 'tool_result',
      content: parts.join('\n'),
      tool_use_id: toolUseID,
    }
  },
} satisfies ToolDef<InputSchema, Output>)
