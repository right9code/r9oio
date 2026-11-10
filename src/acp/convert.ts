import type { ContentBlock, ToolKind } from '@agentclientprotocol/sdk'

/**
 * Translation helpers between ACP wire types and Tau-facing shapes.
 *
 * Inbound only for now: ACP prompt content blocks → a plain prompt string.
 * (Outbound SDKMessage → session/update mapping lives in the real Tau backend,
 * where the SDKMessage stream originates.)
 */

/**
 * Flatten an ACP prompt (a list of content blocks) into a single string.
 *
 * - text                → the text
 * - resource_link       → a `<resource_link .../>` marker with the URI
 * - resource (embedded) → inlined `<resource>…</resource>` text when textual
 * - image / audio       → a placeholder marker (binary handed off elsewhere)
 *
 * Mirrors the conservative approach Kimi's acp/convert.py takes: never drop a
 * block silently — represent unsupported blocks with a visible marker so the
 * model is at least aware of the reference.
 */
export function promptToText(blocks: ContentBlock[]): string {
  const parts: string[] = []
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        parts.push(block.text)
        break
      case 'resource_link':
        parts.push(`<resource_link uri=${JSON.stringify(block.uri)} />`)
        break
      case 'resource': {
        const resource = block.resource
        if (resource && 'text' in resource && typeof resource.text === 'string') {
          parts.push(
            `<resource uri=${JSON.stringify(resource.uri)}>\n${resource.text}\n</resource>`,
          )
        } else {
          parts.push('<resource (binary, omitted) />')
        }
        break
      }
      case 'image':
        parts.push('<image (omitted) />')
        break
      case 'audio':
        parts.push('<audio (omitted) />')
        break
      default:
        parts.push(`<unsupported content block />`)
    }
  }
  return parts.join('\n').trim()
}

/**
 * Best-effort mapping from a Tau tool name to an ACP {@link ToolKind}, used to
 * pick the icon/affordance the editor renders. Falls back to "other".
 */
export function toolKindFromName(toolName: string): ToolKind {
  const name = toolName.toLowerCase()
  if (/(read|view|cat|glob|ls)/.test(name)) return 'read'
  if (/(grep|search|find)/.test(name)) return 'search'
  if (/(edit|write|str_replace|patch|apply)/.test(name)) return 'edit'
  if (/(delete|rm|remove)/.test(name)) return 'delete'
  if (/(move|rename|mv)/.test(name)) return 'move'
  if (/(bash|shell|powershell|exec|run|terminal|pty)/.test(name)) return 'execute'
  if (/(think|plan|reason)/.test(name)) return 'think'
  if (/(fetch|web|http|url|browser)/.test(name)) return 'fetch'
  return 'other'
}
