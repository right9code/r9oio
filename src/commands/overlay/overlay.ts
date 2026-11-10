import type { LocalCommandResult } from '../../commands.js'
import type { ToolUseContext } from '../../Tool.js'
import {
  activateOverlay,
  applyOverlay,
  deactivateOverlay,
  getOverlayStatus,
  isOverlayActive,
  listOverlayChanges,
  rejectOverlay,
} from '../../services/overlay/overlay.js'

/**
 * /overlay — user-facing control of the cumulative-diff sandbox.
 *
 *   /overlay            status: on/off + pending count
 *   /overlay on         start capturing agent file edits in the overlay
 *   /overlay off        stop capturing (pending changes stay on disk)
 *   /overlay diff       print the cumulative diff
 *   /overlay apply      land all pending changes in the real tree
 *   /overlay reject     throw all pending changes away
 */
export async function call(
  args: string,
  _context: ToolUseContext,
): Promise<LocalCommandResult> {
  const sub = args.trim().toLowerCase()

  if (sub === 'on' || sub === 'enable') {
    if (isOverlayActive()) {
      return { type: 'text', value: 'Overlay sandbox is already on.' }
    }
    const state = activateOverlay()
    return {
      type: 'text',
      value: `Overlay sandbox ON — agent file edits now accumulate in the overlay and your real files stay untouched until you apply.\nOverlay: ${state.root}`,
    }
  }

  if (sub === 'off' || sub === 'disable') {
    if (!isOverlayActive()) {
      return { type: 'text', value: 'Overlay sandbox is already off.' }
    }
    const status = await getOverlayStatus()
    if (status.pending > 0) {
      deactivateOverlay()
      return {
        type: 'text',
        value: `Overlay sandbox OFF — ${status.pending} pending change${status.pending === 1 ? '' : 's'} kept on disk at ${status.root}. Re-run /overlay on to pick them back up.`,
      }
    }
    deactivateOverlay()
    return { type: 'text', value: 'Overlay sandbox OFF.' }
  }

  if (sub === 'status' || sub === '') {
    const status = await getOverlayStatus()
    if (!status.active) {
      return { type: 'text', value: 'Overlay sandbox off. Turn it on with /overlay on.' }
    }
    return {
      type: 'text',
      value: `Overlay sandbox on — ${status.pending} pending change${status.pending === 1 ? '' : 's'}.\nOverlay: ${status.root}`,
    }
  }

  if (sub === 'diff' || sub === 'changes') {
    if (!isOverlayActive()) {
      return { type: 'text', value: 'Overlay sandbox is off. Turn it on first: /overlay on' }
    }
    const changes = await listOverlayChanges()
    if (changes.length === 0) {
      return { type: 'text', value: 'No pending overlay changes.' }
    }
    const lines: string[] = []
    for (const c of changes) {
      lines.push(`--- ${c.file} (${c.status})`)
      if (c.binary) {
        lines.push('    (binary file, patch omitted)')
      } else {
        lines.push(c.patch)
      }
    }
    return { type: 'text', value: lines.join('\n') }
  }

  if (sub === 'apply') {
    if (!isOverlayActive()) {
      return { type: 'text', value: 'Overlay sandbox is off — nothing to apply.' }
    }
    const result = await applyOverlay()
    return {
      type: 'text',
      value: `Applied ${result.applied} file${result.applied === 1 ? '' : 's'} and ${result.deleted} deletion${result.deleted === 1 ? '' : 's'} to the real working tree. Sandbox is now off.`,
    }
  }

  if (sub === 'reject') {
    if (!isOverlayActive()) {
      return { type: 'text', value: 'Overlay sandbox is off — nothing to reject.' }
    }
    await rejectOverlay()
    return {
      type: 'text',
      value: 'Rejected all pending overlay changes. Your working tree was never touched.',
    }
  }

  return {
    type: 'text',
    value: `Unknown argument "${args.trim()}". Usage: /overlay on|off|status|diff|apply|reject`,
  }
}
