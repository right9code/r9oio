/**
 * Gemini-on-OpenRouter explicit prompt-cache anchoring.
 *
 * OpenRouter's Gemini caching has two layers (docs: guides/best-practices/
 * prompt-caching; live-measured 2026-07-03 against google/gemini-3.1-flash-lite):
 *
 *  - IMPLICIT (Google-side, automatic): free, but commits asynchronously
 *    (~10-25s) in quantized chunks and misses randomly per replica. At agent
 *    cadence (tool loops seconds apart) consecutive requests keep landing
 *    inside the commit window: measured runs alternated 0% / 85% / 0% turn
 *    over turn with a byte-stable prefix.
 *  - EXPLICIT (cache_control): OpenRouter uses only the LAST breakpoint in
 *    message content. A breakpoint on a byte-stable message triggers a
 *    SYNCHRONOUS cache write that is read back in the same request (measured:
 *    turn 1 read+wrote its full 10.7k prefix and cost 57% less than the
 *    uncached turn), and every later request repeating that prefix reads it
 *    deterministically — no commit lottery. Two hard-won caveats:
 *      1. The explicit cache is also a CEILING: once it exists, implicit
 *         caching stops covering the conversation growing behind it
 *         (measured: reads pinned at exactly the anchor size while prompts
 *         grew 3x). A breakpoint frozen forever therefore DECAYS — the
 *         anchor must advance as the conversation grows.
 *      2. A breakpoint whose position moves EVERY turn writes a cache that
 *         can never be re-used (the pre-fix behavior: sporadic paid writes,
 *         reads left to the implicit lottery — the "terrible cache hit").
 *    The existing last-tool cache_control stamp (openrouter.ts) stays: the
 *    message anchor + tool stamp combination is the recipe that measured
 *    reliable from turn 1; the tool stamp alone is inert for Gemini (0 reads,
 *    0 writes) and never billed a write in any probe, so keeping it is free.
 *
 * Strategy: exactly ONE message breakpoint, advanced in quanta:
 *
 *  - Head anchor = the session-frozen <dynamic_context> volatile message
 *    (pinned at index 1), so [system + tools + volatile] is explicitly
 *    cached from the very first request.
 *  - The anchor advances to a later settled message only when the settled
 *    conversation past the current anchor exceeds a quantum (default 16k
 *    chars ≈ 4k tokens). Between advances the stamped prefix is
 *    byte-identical → deterministic reads; each advance is one synchronous
 *    write covering the whole conversation so far (measured cost of the
 *    combined read+write ≈ 0.4x of plain input — advancing is cheap).
 *  - The anchor position is derived STATELESSLY from message sizes
 *    (quantization), so it is stable across requests, needs no per-session
 *    registry, and recomputes safely after compaction rewrites history.
 *
 * Scope: google/gemini-* model ids on the OpenRouter provider only. Native
 * Gemini / Antigravity lanes have their own cache handling and are untouched.
 */

/** Marks the session-frozen volatile context message (owned by loop.ts). */
export const OPENROUTER_VOLATILE_CONTEXT = Symbol('openrouter volatile context')

interface StampablePart {
  type: string
  text?: string
  cache_control?: { type: string }
}

interface StampableMessage {
  role: string
  content?: string | null | StampablePart[]
  tool_calls?: unknown
  [OPENROUTER_VOLATILE_CONTEXT]?: true
}

export function isGeminiOnOpenRouter(model: string): boolean {
  const id = model.toLowerCase()
  return id.startsWith('google/gemini') || id.includes('gemini-')
}

function anchorQuantumChars(): number {
  const raw = Number(process.env.TAU_OPENROUTER_GEMINI_QUANTUM ?? '')
  if (Number.isFinite(raw) && raw >= 4000) return raw
  // ~4k tokens. Half the backend's own commit quantum: keeps the between-
  // advance sag shallow while advances stay rare relative to turn cadence.
  return 16_000
}

function anchoringDisabled(): boolean {
  const raw = (process.env.TAU_OPENROUTER_GEMINI_ANCHOR ?? '').trim().toLowerCase()
  return raw === '0' || raw === 'off' || raw === 'false'
}

/** Text+tool_calls size proxy for token weight. Images are ignored — they
 * only make the quantum trigger slightly early, never break byte-stability. */
function messageChars(m: StampableMessage): number {
  let n = 0
  if (typeof m.content === 'string') n += m.content.length
  else if (Array.isArray(m.content)) {
    for (const part of m.content) n += part?.text?.length ?? 0
  }
  if (m.tool_calls) n += JSON.stringify(m.tool_calls).length
  return n
}

function stripMessageCacheControl(m: StampableMessage): void {
  if (!Array.isArray(m.content)) return
  for (const part of m.content) {
    if (part && typeof part === 'object' && part.cache_control) delete part.cache_control
  }
}

/** Stamp the last text part; promote string content to a parts array so the
 * marker has somewhere to land. Returns false when nothing was stampable. */
function stampMessage(m: StampableMessage): boolean {
  if (typeof m.content === 'string') {
    m.content = [{
      type: 'text',
      text: m.content.length > 0 ? m.content : ' ',
      cache_control: { type: 'ephemeral' },
    }]
    return true
  }
  if (Array.isArray(m.content)) {
    for (let i = m.content.length - 1; i >= 0; i--) {
      const part = m.content[i]
      if (part && part.type === 'text') {
        part.cache_control = { type: 'ephemeral' }
        return true
      }
    }
  }
  return false
}

/**
 * Pick the anchor index for the single Gemini breakpoint.
 *
 * Candidates are non-system messages whose prefix is settled: everything
 * except the trailing run of user/tool messages (the in-flight prompt/tool
 * results of THIS request). The frozen volatile message is always a
 * candidate — it is byte-stable by construction even on turn 1. When no
 * candidate exists at all (bare first turn without a volatile block), the
 * fresh user tail itself is used: next turn that same message is a settled
 * candidate, so the prefix cached now is exactly the prefix read then.
 *
 * Advancing rule (stateless quantization): anchor = the furthest candidate
 * whose cumulative size stays within head + k·Q, where k grows only as the
 * settled conversation grows. Between quantum crossings the pick — and the
 * stamped prefix — is byte-identical across requests.
 */
export function pickGeminiOpenRouterAnchorIndex(
  messages: StampableMessage[],
  quantumChars: number = anchorQuantumChars(),
): number {
  // End of the settled region: walk back over the trailing user/tool run.
  let lastSettled = messages.length - 1
  while (lastSettled >= 0) {
    const m = messages[lastSettled]!
    const trailing = (m.role === 'user' || m.role === 'tool') && !m[OPENROUTER_VOLATILE_CONTEXT]
    if (!trailing) break
    lastSettled--
  }

  const candidates: Array<{ index: number; cum: number }> = []
  let cum = 0
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!
    cum += messageChars(m)
    if (m.role === 'system') continue
    if (i <= lastSettled || m[OPENROUTER_VOLATILE_CONTEXT]) {
      candidates.push({ index: i, cum })
    }
  }

  if (candidates.length === 0) {
    // Bare first turn: stamp the fresh user tail (see doc comment above).
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]!.role === 'user') return i
    }
    return -1
  }

  const head = candidates[0]!.cum
  const total = candidates[candidates.length - 1]!.cum
  const target = head + Math.floor(Math.max(0, total - head) / quantumChars) * quantumChars
  let pick = candidates[0]!.index
  for (const c of candidates) {
    if (c.cum <= target) pick = c.index
  }
  return pick
}

/**
 * Apply the single quantized cache anchor for a Gemini-on-OpenRouter request.
 * Strips every other message-level cache_control first so "only the last
 * breakpoint is used" can never select a stale marker.
 */
export function applyGeminiOpenRouterCacheAnchor(messages: StampableMessage[]): void {
  for (const m of messages) stripMessageCacheControl(m)
  if (anchoringDisabled()) return

  let anchor = pickGeminiOpenRouterAnchorIndex(messages)
  // Walk toward the head if the picked message has no stampable text part
  // (e.g. an assistant message that is only tool_calls).
  while (anchor >= 0) {
    const m = messages[anchor]!
    if (m.role !== 'system' && stampMessage(m)) return
    anchor--
  }
}
