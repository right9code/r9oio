import type { StopReason, ToolKind } from '@agentclientprotocol/sdk'

/**
 * Backend seam between the ACP protocol layer and Tau's agent engine.
 *
 * The ACP layer (agent.ts / index.ts) is fully self-contained: it speaks the
 * wire protocol, manages sessions, and bridges permissions. It knows nothing
 * about how a turn is actually run. A `TauAcpBackend` plugs in the "brain".
 *
 * This keeps the protocol correct and testable on its own (see EchoBackend)
 * and isolates the heavy integration — standing up a real Tau session with a
 * full ToolUseContext (tool pool, MCP clients, app state, permission system),
 * the same bootstrap `tau server` / headless print mode perform — to a single
 * implementation that can be swapped in without touching the protocol code.
 */

/** Outcome of an ACP permission request, normalized for the backend. */
export type PermissionOutcome =
  | 'allow_once'
  | 'allow_always'
  | 'reject_once'
  | 'reject_always'
  | 'cancelled'

/** A tool call the backend reports to the editor for rendering. */
export type BackendToolCall = {
  toolCallId: string
  title: string
  kind: ToolKind
  rawInput?: unknown
  /** Absolute file paths this call touches, for editor "following". */
  locations?: { path: string; line?: number }[]
}

/**
 * A select-style session configuration option surfaced to the editor — e.g. a
 * model picker (`category: 'model'`) or a reasoning/thinking selector
 * (`category: 'thought_level'`). The ACP layer renders these as native
 * dropdowns; clients that don't support config options ignore them.
 */
export type AcpConfigOption = {
  id: string
  name: string
  category?: 'model' | 'thought_level'
  description?: string
  /** Currently selected option value. */
  currentValue: string
  options: { value: string; name: string; description?: string }[]
}

/** A slash command surfaced to the editor's command menu. */
export type AcpCommand = {
  name: string
  description?: string
  /** Hint shown for free-text arguments after the command name. */
  argumentHint?: string
}

/**
 * The surface a backend uses to report turn output back to the editor.
 * Every method maps to one ACP `session/update` (or `session/request_permission`)
 * and is implemented by the ACP layer in agent.ts.
 */
export interface TurnContext {
  /** Aborts when the editor sends `session/cancel` or the connection closes. */
  readonly signal: AbortSignal
  /** Streamed assistant text → `agent_message_chunk`. */
  agentText(text: string): Promise<void>
  /** Streamed reasoning → `agent_thought_chunk`. */
  agentThought(text: string): Promise<void>
  /** Announce a tool call (status: pending) → `tool_call`. */
  toolCall(call: BackendToolCall): Promise<void>
  /** Update a tool call's status/output → `tool_call_update`. */
  toolCallUpdate(update: {
    toolCallId: string
    status: 'in_progress' | 'completed' | 'failed'
    content?: string
    rawOutput?: unknown
  }): Promise<void>
  /**
   * Ask the editor to authorize a tool call → `session/request_permission`.
   * Resolves with the user's choice (or 'cancelled' if the turn was cancelled).
   */
  requestPermission(call: BackendToolCall): Promise<PermissionOutcome>
}

/** Pluggable agent engine. One implementation hosts the real Tau loop. */
export interface TauAcpBackend {
  /** Called once per `session/new`. `cwd` is the editor's workspace root. */
  newSession(opts: { sessionId: string; cwd: string }): Promise<void> | void
  /** Run one prompt turn to completion, reporting output via `ctx`. */
  runTurn(opts: {
    sessionId: string
    prompt: string
    ctx: TurnContext
  }): Promise<StopReason>
  /** Optional: free per-session resources. */
  closeSession?(sessionId: string): void
  /**
   * Optional: the model/thinking selectors to advertise for a session, once the
   * engine handshake has populated them. Returns `[]` when none are available.
   */
  configOptions?(sessionId: string): AcpConfigOption[]
  /**
   * Optional: apply a config-option change (e.g. switch model) and return the
   * full, updated option set.
   */
  setConfigOption?(
    sessionId: string,
    configId: string,
    value: string,
  ): AcpConfigOption[]
  /** Optional: slash commands to surface in the editor's command menu. */
  availableCommands?(sessionId: string): AcpCommand[]
}

/**
 * A minimal, dependency-free backend that proves the full protocol path
 * (handshake → session → streamed text → tool call → tool result) end-to-end
 * inside a real editor. It does not run the model; it echoes the prompt and
 * demonstrates a read-only tool call. Swap this for the real Tau engine
 * backend in src/acp/index.ts's default wiring.
 */
export class EchoBackend implements TauAcpBackend {
  newSession(): void {}

  async runTurn({
    prompt,
    ctx,
  }: {
    sessionId: string
    prompt: string
    ctx: TurnContext
  }): Promise<StopReason> {
    if (ctx.signal.aborted) return 'cancelled'

    await ctx.agentText(
      `Tau ACP backend is connected. You said:\n\n> ${prompt}\n\n` +
        `The protocol path (streaming, tool calls, permissions) is live; ` +
        `the Tau agent engine is not yet wired into this backend.`,
    )

    // Demonstrate a tool call so the editor's tool-rendering path is exercised.
    const toolCallId = 'echo-1'
    await ctx.toolCall({
      toolCallId,
      title: 'Inspect workspace',
      kind: 'read',
      rawInput: { note: 'echo backend demo' },
    })
    if (ctx.signal.aborted) return 'cancelled'
    await ctx.toolCallUpdate({
      toolCallId,
      status: 'completed',
      content: 'echo backend: no real filesystem access performed',
    })

    return 'end_turn'
  }
}
