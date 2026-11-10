import {
  type AgentSideConnection,
  type AuthenticateRequest,
  type AuthenticateResponse,
  type CancelNotification,
  type InitializeRequest,
  type InitializeResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type SessionConfigOption,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
  type SetSessionModeRequest,
  type SetSessionModeResponse,
  PROTOCOL_VERSION,
} from '@agentclientprotocol/sdk'
import type {
  AcpConfigOption,
  BackendToolCall,
  PermissionOutcome,
  TauAcpBackend,
  TurnContext,
} from './backend.js'
import { promptToText } from './convert.js'

/** Convert a backend config option into the ACP wire shape (a select). */
function toWireConfigOption(opt: AcpConfigOption): SessionConfigOption {
  return {
    type: 'select',
    currentValue: opt.currentValue,
    options: opt.options.map(o => ({
      value: o.value,
      name: o.name,
      description: o.description,
    })),
    id: opt.id,
    name: opt.name,
    category: opt.category,
    description: opt.description,
  }
}

type SessionState = {
  cwd: string
  /** Controls the in-flight prompt turn; aborted by `session/cancel`. */
  turn?: AbortController
}

/**
 * Tau's agent-side ACP implementation. One instance per connection; an editor
 * may create multiple sessions over it. Implements the methods an ACP client
 * (Zed, JetBrains, the VS Code ACP Client extension, …) calls, and turns the
 * backend's turn output into `session/update` notifications.
 *
 * Structurally matches the SDK's `Agent` interface — passed to
 * `AgentSideConnection` in index.ts, which type-checks the shape.
 */
export class TauAcpAgent {
  private readonly sessions = new Map<string, SessionState>()

  constructor(
    private readonly conn: AgentSideConnection,
    private readonly backend: TauAcpBackend,
  ) {}

  async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        // No history replay yet — sessions are not persisted across restarts.
        loadSession: false,
        promptCapabilities: {
          image: true,
          audio: false,
          embeddedContext: true,
        },
      },
      // No auth gate: auth is handled by Tau's own `tau /login`, out of band.
      authMethods: [],
    }
  }

  async authenticate(
    _params: AuthenticateRequest,
  ): Promise<AuthenticateResponse> {
    return {}
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    const sessionId = crypto.randomUUID()
    this.sessions.set(sessionId, { cwd: params.cwd })
    await this.backend.newSession({ sessionId, cwd: params.cwd })
    const configOptions = this.backend
      .configOptions?.(sessionId)
      ?.map(toWireConfigOption)
    // Push Tau's slash commands into the editor's command menu. Deferred to a
    // macrotask so the new-session response is written first — the notification
    // must reference an already-established session.
    this.scheduleAvailableCommands(sessionId)
    return configOptions?.length ? { sessionId, configOptions } : { sessionId }
  }

  /** Emit an `available_commands_update` for the editor's command menu. */
  private scheduleAvailableCommands(sessionId: string): void {
    const commands = this.backend.availableCommands?.(sessionId)
    if (!commands || commands.length === 0) return
    setTimeout(() => {
      void this.conn
        .sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: 'available_commands_update',
            availableCommands: commands.map(c => ({
              name: c.name,
              description: c.description ?? '',
              input: c.argumentHint ? { hint: c.argumentHint } : undefined,
            })),
          },
        })
        .catch(() => {})
    }, 0)
  }

  async setSessionMode(
    _params: SetSessionModeRequest,
  ): Promise<SetSessionModeResponse> {
    // Single-mode for now; advertised modes are not exposed yet.
    return {}
  }

  /** Apply a model/thinking selection from the editor's config dropdowns. */
  async setSessionConfigOption(
    params: SetSessionConfigOptionRequest,
  ): Promise<SetSessionConfigOptionResponse> {
    const value =
      'value' in params && typeof params.value === 'string'
        ? params.value
        : String((params as { value: unknown }).value)
    const updated =
      this.backend.setConfigOption?.(params.sessionId, params.configId, value) ??
      []
    return { configOptions: updated.map(toWireConfigOption) }
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const session = this.sessions.get(params.sessionId)
    if (!session) {
      throw new Error(`Unknown session: ${params.sessionId}`)
    }

    session.turn?.abort()
    const turn = new AbortController()
    session.turn = turn

    const ctx = this.makeTurnContext(params.sessionId, turn.signal)

    try {
      const stopReason = await this.backend.runTurn({
        sessionId: params.sessionId,
        prompt: promptToText(params.prompt),
        ctx,
      })
      return { stopReason }
    } catch (err) {
      if (turn.signal.aborted) {
        return { stopReason: 'cancelled' }
      }
      throw err
    } finally {
      if (session.turn === turn) session.turn = undefined
    }
  }

  async cancel(params: CancelNotification): Promise<void> {
    this.sessions.get(params.sessionId)?.turn?.abort()
  }

  /** Build the backend-facing reporter that emits ACP session updates. */
  private makeTurnContext(
    sessionId: string,
    signal: AbortSignal,
  ): TurnContext {
    const conn = this.conn
    return {
      signal,
      async agentText(text: string) {
        await conn.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text },
          },
        })
      },
      async agentThought(text: string) {
        await conn.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: 'agent_thought_chunk',
            content: { type: 'text', text },
          },
        })
      },
      async toolCall(call: BackendToolCall) {
        await conn.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: call.toolCallId,
            title: call.title,
            kind: call.kind,
            status: 'pending',
            rawInput: call.rawInput,
            locations: call.locations,
          },
        })
      },
      async toolCallUpdate(update) {
        await conn.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: update.toolCallId,
            status: update.status,
            content:
              update.content === undefined
                ? undefined
                : [
                    {
                      type: 'content',
                      content: { type: 'text', text: update.content },
                    },
                  ],
            rawOutput: update.rawOutput,
          },
        })
      },
      async requestPermission(call: BackendToolCall): Promise<PermissionOutcome> {
        const response = await conn.requestPermission({
          sessionId,
          toolCall: {
            toolCallId: call.toolCallId,
            title: call.title,
            kind: call.kind,
            status: 'pending',
            rawInput: call.rawInput,
            locations: call.locations,
          },
          options: [
            { kind: 'allow_once', name: 'Allow', optionId: 'allow_once' },
            {
              kind: 'allow_always',
              name: 'Always allow',
              optionId: 'allow_always',
            },
            { kind: 'reject_once', name: 'Reject', optionId: 'reject_once' },
          ],
        })
        const outcome = response.outcome
        if (outcome.outcome === 'cancelled') return 'cancelled'
        return outcome.optionId as PermissionOutcome
      },
    }
  }
}
