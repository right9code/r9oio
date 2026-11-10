import { spawn, type ChildProcess } from 'node:child_process'
import type { StopReason } from '@agentclientprotocol/sdk'
import type {
  AcpCommand,
  AcpConfigOption,
  TauAcpBackend,
  TurnContext,
} from './backend.js'
import { toolKindFromName } from './convert.js'

/**
 * The real Tau engine backend for ACP.
 *
 * Rather than re-deriving Tau's ~1000-line headless bootstrap (tool pool, app
 * state, MCP, model/auth), this drives Tau's own headless `stream-json` mode —
 * the same way the Claude Agent SDK drives the CLI. The child inherits the
 * user's config and `/login` auth automatically. Its SDKMessage stdout is
 * translated into ACP `session/update` notifications.
 *
 * PERSISTENT CHILD (the key to responsiveness): one long-lived child is spawned
 * per ACP session and each prompt turn is written to its stdin as a streaming
 * `user` message. The full Tau cold start (provider/auth/tool bootstrap) is
 * therefore paid ONCE per session instead of once per turn — every turn after
 * the first lands on a warm process. Continuity is automatic (the child keeps
 * the conversation in-process), so no `--resume` dance is needed. Cancel uses
 * the `interrupt` control request and shutdown uses `end_session`, rather than
 * killing the process.
 *
 * Permissions (v1): the child runs with `--dangerously-skip-permissions`, so
 * tools execute without an interactive prompt — but every tool call is surfaced
 * to the editor for visibility.
 *
 * Env toggles:
 *  - `TAU_ACP_DEBUG=1`   — forward the child's stderr to ours for debugging.
 *  - `TAU_ACP_NO_USAGE=1`— suppress the per-turn cache/token footer.
 */

/** Structural shapes of the stream-json messages Tau emits (loose on purpose). */
type ContentBlock = {
  type: string
  text?: string
  thinking?: string
  id?: string
  name?: string
  input?: unknown
  tool_use_id?: string
  content?: unknown
  is_error?: boolean
}
/** Per-turn token accounting carried on the `result` message. */
type Usage = {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}
type StreamMsg = {
  type: string
  subtype?: string
  session_id?: string
  model?: string
  stop_reason?: string
  is_error?: boolean
  result?: string
  message?: { content?: ContentBlock[] }
  usage?: Usage
  total_cost_usd?: number
  /** Present on `control_response`: { subtype, request_id, response }. */
  response?: {
    subtype?: string
    request_id?: string
    response?: InitResponse
  }
}

/** Subset of a model entry from the engine's `initialize` response. */
type ModelInfo = {
  value: string
  displayName?: string
  description?: string
  supportsEffort?: boolean
  supportedEffortLevels?: string[]
}
/** Subset of a slash command from the engine's `initialize` response. */
type CommandInfo = {
  name: string
  description?: string
  argumentHint?: string
}
/** The payload the engine returns for an `initialize` control request. */
type InitResponse = {
  models?: ModelInfo[]
  commands?: CommandInfo[]
}

/** The in-flight turn a child's output is currently being routed to. */
type PendingTurn = {
  ctx: TurnContext
  finish: (reason: StopReason) => void
}

/** One long-lived Tau child + the parsing/turn state bound to it. */
type ChildSession = {
  cwd: string
  proc: ChildProcess
  tauSessionId?: string
  /** Partial trailing stdout line awaiting its newline. */
  buffer: string
  /** Serializes async update emission so text/tool ordering is preserved. */
  chain: Promise<void>
  /** The turn currently consuming this child's output, if any. */
  pending?: PendingTurn
  /** Set once the process has errored/closed/exited. */
  exited: boolean
  /** Resolves when the `initialize` handshake completes (or times out). */
  ready: Promise<void>
  /** Resolver for {@link ready}; called when the init response arrives. */
  resolveReady?: () => void
  /** request_id of the in-flight `initialize` control request. */
  initRequestId?: string
  /** Models advertised by the engine (populated by the handshake). */
  models: ModelInfo[]
  /** Slash commands advertised by the engine (populated by the handshake). */
  commands: CommandInfo[]
  /** Currently selected model option value (the model picker's currentValue). */
  currentModel: string
  /** Currently selected thinking-level value (the thinking picker's value). */
  currentThinking: string
}

/** Thinking-level option ids → `set_max_thinking_tokens` budgets. */
const THINKING_TOKENS: Record<string, number | null> = {
  default: null, // engine default (clears any override)
  off: 0, // thinking disabled
  low: 4096,
  medium: 10000,
  high: 24000,
}

export class TauEngineBackend implements TauAcpBackend {
  private readonly sessions = new Map<string, ChildSession>()
  /** Path to the running bundle (dist/tau.mjs) — reused to spawn children. */
  private readonly entry = process.argv[1] ?? ''

  async newSession({
    sessionId,
    cwd,
  }: {
    sessionId: string
    cwd: string
  }): Promise<void> {
    // Spawn eagerly and run the initialize handshake here so (a) the one-time
    // cold start is paid during session creation — the first prompt then lands
    // on a warm process — and (b) the model/command list is known in time to
    // advertise it in the new-session response.
    const session = this.spawnChild(sessionId, cwd)
    await session.ready
  }

  /** Model / thinking selectors to advertise for this session. */
  configOptions(sessionId: string): AcpConfigOption[] {
    const session = this.sessions.get(sessionId)
    if (!session) return []
    const options: AcpConfigOption[] = []

    if (session.models.length > 0) {
      options.push({
        id: 'model',
        name: 'Model',
        category: 'model',
        currentValue: session.currentModel,
        options: session.models.map(m => ({
          value: m.value,
          name: m.displayName ?? m.value,
          description: m.description,
        })),
      })
    }

    options.push({
      id: 'thinking',
      name: 'Thinking',
      category: 'thought_level',
      description: 'Reasoning effort (maps to the thinking-token budget).',
      currentValue: session.currentThinking,
      options: [
        { value: 'default', name: 'Default' },
        { value: 'off', name: 'Off' },
        { value: 'low', name: 'Low', description: '~4K tokens' },
        { value: 'medium', name: 'Medium', description: '~10K tokens' },
        { value: 'high', name: 'High', description: '~24K tokens' },
      ],
    })

    return options
  }

  /** Apply a model/thinking change to the live child and return the new set. */
  setConfigOption(
    sessionId: string,
    configId: string,
    value: string,
  ): AcpConfigOption[] {
    const session = this.sessions.get(sessionId)
    if (!session) return []

    if (configId === 'model') {
      session.currentModel = value
      this.sendControl(session, { subtype: 'set_model', model: value })
    } else if (configId === 'thinking') {
      session.currentThinking = value
      const tokens = value in THINKING_TOKENS ? THINKING_TOKENS[value] : null
      this.sendControl(session, {
        subtype: 'set_max_thinking_tokens',
        max_thinking_tokens: tokens,
      })
    }

    return this.configOptions(sessionId)
  }

  /** Slash commands advertised by the engine, for the editor's command menu. */
  availableCommands(sessionId: string): AcpCommand[] {
    const session = this.sessions.get(sessionId)
    if (!session) return []
    return session.commands.map(c => ({
      name: c.name,
      description: c.description,
      argumentHint: c.argumentHint,
    }))
  }

  closeSession(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    this.sessions.delete(sessionId)
    session.pending?.finish('cancelled')
    // Ask the engine to wind down cleanly, then close its stdin (EOF).
    this.sendControl(session, {
      subtype: 'end_session',
      reason: 'client closed session',
    })
    try {
      session.proc.stdin?.end()
    } catch {
      // already closed
    }
    // Hard stop if it lingers past a grace period.
    const t = setTimeout(() => {
      if (!session.exited) {
        try {
          session.proc.kill()
        } catch {
          // already gone
        }
      }
    }, 2000)
    t.unref?.()
  }

  async runTurn({
    sessionId,
    prompt,
    ctx,
  }: {
    sessionId: string
    prompt: string
    ctx: TurnContext
  }): Promise<StopReason> {
    const session = this.ensureChild(sessionId)
    if (session.exited) {
      await ctx.agentText(
        '\n[tau acp] The engine process is not running. ' +
          'Check that a provider is configured (`tau` then `/login`).',
      )
      return 'end_turn'
    }

    return await new Promise<StopReason>(resolve => {
      let settled = false
      let abortTimer: ReturnType<typeof setTimeout> | undefined

      const finish = (reason: StopReason): void => {
        if (settled) return
        settled = true
        if (abortTimer) clearTimeout(abortTimer)
        ctx.signal.removeEventListener('abort', onAbort)
        if (session.pending === pending) session.pending = undefined
        resolve(ctx.signal.aborted ? 'cancelled' : reason)
      }

      const onAbort = (): void => {
        // Real cancel: interrupt the current turn rather than killing the
        // child. The engine still emits a `result`, which resolves us via the
        // result branch; the timer is only a safety net against a missing one.
        this.sendControl(session, { subtype: 'interrupt' })
        abortTimer = setTimeout(() => finish('cancelled'), 4000)
        abortTimer.unref?.()
      }

      const pending: PendingTurn = { ctx, finish }
      // Turns are sequential per ACP session (prompt() is awaited), so a single
      // pending slot is correct; the prior turn has already resolved.
      session.pending = pending
      ctx.signal.addEventListener('abort', onAbort)
      if (ctx.signal.aborted) {
        onAbort()
        return
      }

      this.writeUser(session, prompt)
    })
  }

  // ---- internals -----------------------------------------------------------

  /** Return a live child for the session, (re)spawning if needed. */
  private ensureChild(sessionId: string): ChildSession {
    const existing = this.sessions.get(sessionId)
    if (existing && !existing.exited) return existing
    return this.spawnChild(sessionId, existing?.cwd ?? process.cwd())
  }

  private spawnChild(sessionId: string, cwd: string): ChildSession {
    const proc = spawn(
      process.execPath,
      [
        this.entry,
        '--print',
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
        '--verbose',
        '--dangerously-skip-permissions',
      ],
      {
        cwd,
        stdio: ['pipe', 'pipe', process.env.TAU_ACP_DEBUG ? 'inherit' : 'ignore'],
        // TAU_ACP_CHILD: the child's stdin is a pipe the bundle can mis-detect
        // as a TTY, which would skip stream-json input; the flag forces the read.
        env: { ...process.env, TAU_ACP_CHILD: '1' },
      },
    )

    let resolveReady!: () => void
    const ready = new Promise<void>(resolve => {
      resolveReady = resolve
    })

    const session: ChildSession = {
      cwd,
      proc,
      buffer: '',
      chain: Promise.resolve(),
      exited: false,
      ready,
      models: [],
      commands: [],
      currentModel: 'default',
      currentThinking: 'default',
    }
    this.sessions.set(sessionId, session)

    const stdout = proc.stdout
    if (stdout) {
      stdout.setEncoding('utf8')
      stdout.on('data', (chunk: string) => {
        session.buffer += chunk
        const lines = session.buffer.split('\n')
        session.buffer = lines.pop() ?? ''
        for (const line of lines) this.consumeLine(session, line)
      })
      stdout.on('end', () => {
        if (session.buffer) this.consumeLine(session, session.buffer)
      })
    }

    const onDead = (): void => {
      if (session.exited) return
      session.exited = true
      session.pending?.finish('end_turn')
      resolveReady()
    }
    proc.on('error', onDead)
    proc.on('close', onDead)
    proc.on('exit', onDead)

    // Handshake: ask the warming engine for its model/command list. The reply
    // (a control_response matching this id) resolves `ready`; a timeout keeps
    // session creation from hanging if the engine never answers.
    session.initRequestId = crypto.randomUUID()
    session.resolveReady = resolveReady
    this.sendControl(
      session,
      { subtype: 'initialize' },
      session.initRequestId,
    )
    const initTimer = setTimeout(() => resolveReady(), 30000)
    initTimer.unref?.()
    void ready.then(() => clearTimeout(initTimer))

    return session
  }

  private consumeLine(session: ChildSession, line: string): void {
    const trimmed = line.trim()
    if (!trimmed) return
    let msg: StreamMsg
    try {
      msg = JSON.parse(trimmed) as StreamMsg
    } catch {
      // Tolerate non-JSON lines (e.g. terminal reset codes printed at exit).
      return
    }
    session.chain = session.chain
      .then(() => this.handleMessage(msg, session))
      .catch(() => {})
  }

  private async handleMessage(
    msg: StreamMsg,
    session: ChildSession,
  ): Promise<void> {
    const ctx = session.pending?.ctx
    switch (msg.type) {
      case 'system':
        // `init` is emitted at the start of every turn; the session id is stable.
        if (msg.subtype === 'init' && msg.session_id) {
          session.tauSessionId = msg.session_id
        }
        return
      case 'assistant': {
        if (!ctx) return
        for (const block of msg.message?.content ?? []) {
          if (block.type === 'text' && block.text) {
            await ctx.agentText(block.text)
          } else if (block.type === 'thinking' && block.thinking) {
            await ctx.agentThought(block.thinking)
          } else if (block.type === 'tool_use' && block.id && block.name) {
            await ctx.toolCall({
              toolCallId: block.id,
              title: block.name,
              kind: toolKindFromName(block.name),
              rawInput: block.input,
            })
          }
        }
        return
      }
      case 'user': {
        if (!ctx) return
        for (const block of msg.message?.content ?? []) {
          if (block.type === 'tool_result' && block.tool_use_id) {
            await ctx.toolCallUpdate({
              toolCallId: block.tool_use_id,
              status: block.is_error ? 'failed' : 'completed',
              content: stringifyToolResult(block.content),
            })
          }
        }
        return
      }
      case 'result': {
        if (!ctx) return
        await this.emitUsage(ctx, msg)
        session.pending?.finish(mapStopReason(msg.stop_reason))
        return
      }
      case 'control_response': {
        // The reply to our `initialize` handshake carries the model/command
        // list; capture it and unblock session creation.
        if (
          msg.response?.request_id &&
          msg.response.request_id === session.initRequestId
        ) {
          const payload = msg.response.response
          if (Array.isArray(payload?.models)) session.models = payload.models
          if (Array.isArray(payload?.commands)) session.commands = payload.commands
          session.initRequestId = undefined
          session.resolveReady?.()
        }
        return
      }
    }
  }

  /**
   * Surface cache effectiveness out-of-band as a dim "thought" — never appended
   * to the answer. Reports the cache HIT RATE (share of the prompt served from
   * cache this turn) as a percentage, plus the running session cost. Disable
   * entirely with `TAU_ACP_NO_USAGE=1`.
   */
  private async emitUsage(ctx: TurnContext, msg: StreamMsg): Promise<void> {
    if (process.env.TAU_ACP_NO_USAGE === '1') return
    const u = msg.usage
    if (!u) return
    const read = u.cache_read_input_tokens ?? 0
    const created = u.cache_creation_input_tokens ?? 0
    const input = u.input_tokens ?? 0
    const promptTokens = read + created + input
    if (promptTokens === 0) return
    const pct = Math.round((read / promptTokens) * 100)
    const cost =
      typeof msg.total_cost_usd === 'number'
        ? ` · $${msg.total_cost_usd.toFixed(2)}`
        : ''
    await ctx.agentThought(`⚡ ${pct}% cached${cost}`)
  }

  /** Write one streaming `user` turn to the persistent child's stdin. */
  private writeUser(session: ChildSession, content: string): void {
    try {
      session.proc.stdin?.write(
        JSON.stringify({
          type: 'user',
          message: { role: 'user', content },
          parent_tool_use_id: null,
        }) + '\n',
      )
    } catch {
      // stdin closed (child exited); the exit handler resolves the turn.
    }
  }

  /** Send a control request (initialize / interrupt / set_model / …). */
  private sendControl(
    session: ChildSession,
    request: Record<string, unknown>,
    requestId: string = crypto.randomUUID(),
  ): void {
    try {
      session.proc.stdin?.write(
        JSON.stringify({
          type: 'control_request',
          request_id: requestId,
          request,
        }) + '\n',
      )
    } catch {
      // already closed
    }
  }
}

/** Map Tau's result stop_reason onto an ACP {@link StopReason}. */
function mapStopReason(reason: string | undefined): StopReason {
  switch (reason) {
    case 'end_turn':
      return 'end_turn'
    case 'max_tokens':
      return 'max_tokens'
    case 'refusal':
      return 'refusal'
    default:
      return 'end_turn'
  }
}

/** Flatten a tool_result's `content` (string | block[] | object) to text. */
function stringifyToolResult(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map(part =>
        typeof part === 'string'
          ? part
          : typeof (part as { text?: string })?.text === 'string'
            ? (part as { text: string }).text
            : JSON.stringify(part),
      )
      .join('\n')
  }
  return content == null ? '' : JSON.stringify(content)
}
