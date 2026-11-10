import { isEnvTruthy } from './envUtils.js'

/**
 * Master switch for OPTIONAL background model calls: session-title
 * generation, tool-use summary lines, away summaries, and skill-improvement
 * rewrites. They are cosmetic — their output never feeds back into the main
 * conversation, so disabling them cannot change answer quality. Every fire
 * is a full extra request (quota on request-limited providers such as
 * Antigravity) plus its own uncached prompt tail on metered ones.
 *
 * DEFAULT: OFF (disabled) — the request/quota cost buys UI decoration only.
 * Re-enable with TAU_SIDE_QUERIES=1. The explicit off-switches keep working
 * and win over the opt-in:
 *   DISABLE_NON_ESSENTIAL_MODEL_CALLS=1   or   TAU_NO_SIDE_QUERIES=1
 *
 * Functional model calls are NOT affected: permission prefix detection,
 * WebSearch result processing, user-invoked commands (/rename, feedback,
 * session search), user-configured hooks, and API-key verification.
 *
 * (Self-learning memory extraction has its own purpose-built toggle —
 * `/learned off` — since it also controls non-model memory behavior. It is
 * deliberately NOT covered here: it feeds future sessions, not the UI.)
 */
export function areNonEssentialModelCallsDisabled(): boolean {
  if (
    isEnvTruthy(process.env.DISABLE_NON_ESSENTIAL_MODEL_CALLS) ||
    isEnvTruthy(process.env.TAU_NO_SIDE_QUERIES)
  ) {
    return true
  }
  return !isEnvTruthy(process.env.TAU_SIDE_QUERIES)
}
