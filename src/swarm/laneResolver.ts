/**
 * Single source of truth for picking the LEAD (master) and EXEC (servant)
 * lanes of a swarm session.
 *
 * Both entry points — the interactive wizard and the headless `/swarm` path —
 * must go through here, so the same invariants hold everywhere:
 *
 *   1. a lane is a concrete provider+model id (never a sentinel),
 *   2. the two lanes are distinct,
 *   3. both lanes come from the healthy set when one is supplied.
 *
 * When the invariants cannot be met the resolver fails with a reason the caller
 * shows to the user. It never silently falls back to "whatever was first",
 * which is how an unpinnable sentinel used to end up as the EXEC lane.
 */

import type { ModelOption } from './modelHealth.js'
import { isCustomProvider } from '../utils/customProviders.js'
import { isAPIProvider } from '../utils/model/providers.js'

/** Catalog sentinel for "use the current session model". Never a real lane. */
export const SESSION_DEFAULT_SENTINEL = 'active-session-default'

export type StoredSwarmLane = { provider: string; model: string } | undefined

export type StoredSwarmDefaults =
  | { master?: StoredSwarmLane; servant?: StoredSwarmLane }
  | null
  | undefined

export type SwarmLanePick = {
  model: ModelOption
  /** Which step of the ladder produced this pick — surfaced in the UI. */
  reason: string
}

export type SwarmLaneResolution =
  | { ok: true; master: SwarmLanePick; servant: SwarmLanePick }
  | { ok: false; reason: string }

export function laneKey(model: ModelOption): string {
  return `${model.provider}:${model.modelId}`
}

/** A lane with a real provider+model id — the minimum for any selection. */
export function isConcreteLane(model: ModelOption | null | undefined): model is ModelOption {
  if (!model?.provider || !model.modelId) return false
  return model.modelId !== SESSION_DEFAULT_SENTINEL
}

/**
 * A lane a spawn can actually be pinned to: concrete, and on a provider the
 * provider stack can route per-spawn (built-in APIProvider or a configured
 * custom gateway). The catalog lists some direct-cloud ids whose provider name
 * is not routable, and those must never win a lane.
 */
export function isPinnableLane(model: ModelOption | null | undefined): model is ModelOption {
  if (!isConcreteLane(model)) return false
  return isAPIProvider(model.provider) || isCustomProvider(model.provider)
}

function byLatency(a: ModelOption, b: ModelOption): number {
  return (a.latencyMs ?? Number.MAX_SAFE_INTEGER) - (b.latencyMs ?? Number.MAX_SAFE_INTEGER)
}

function storedMatch(pool: ModelOption[], stored: StoredSwarmLane): ModelOption | undefined {
  if (!stored?.provider || !stored.model) return undefined
  return pool.find(m => m.provider === stored.provider && m.modelId === stored.model)
}

/** First model matching `pred`, preferring the fastest when several qualify. */
function pick(pool: ModelOption[], pred: (m: ModelOption) => boolean): ModelOption | undefined {
  return pool.filter(pred).sort(byLatency)[0]
}

const isStrongLane = (m: ModelOption): boolean =>
  m.tier === 'opus' ||
  m.tier === 'sonnet' ||
  m.provider === 'anthropic' ||
  m.provider === 'omniroute' ||
  /opus|sonnet|reason/i.test(m.modelId)

const isFastLane = (m: ModelOption): boolean =>
  m.tier === 'haiku' || /flash|mini|haiku|deepseek/i.test(m.modelId)

/**
 * Resolve the LEAD/EXEC lanes.
 *
 * @param catalog   Every model the caller is willing to consider.
 * @param opts.stored   Persisted `swarmDefaults`; invalid entries are ignored.
 * @param opts.healthy  Models that answered a health check. When omitted the
 *                      catalog is treated as healthy.
 * @param opts.exclude  Lane the EXEC pick must differ from (the chosen LEAD).
 */
export function resolveSwarmLanes(
  catalog: ModelOption[],
  opts: { stored?: StoredSwarmDefaults; healthy?: ModelOption[]; exclude?: ModelOption | null } = {},
): SwarmLaneResolution {
  const concrete = catalog.filter(isPinnableLane)
  if (concrete.length === 0) {
    return {
      ok: false,
      reason:
        'No pinnable models in the catalog — nothing there can be routed per-spawn. Check your providers with /provider and /swarm ping.',
    }
  }

  const healthyKeys = opts.healthy
    ? new Set(opts.healthy.filter(isPinnableLane).map(laneKey))
    : null
  const usable = healthyKeys ? concrete.filter(m => healthyKeys.has(laneKey(m))) : concrete
  if (usable.length === 0) {
    return {
      ok: false,
      reason: 'No healthy concrete model answered — nothing can be pinned. Rescan, or check credentials with /swarm ping.',
    }
  }

  const master = resolveMaster(usable, opts.stored)
  if (!master) {
    return { ok: false, reason: 'Could not pick a LEAD lane from the available models.' }
  }

  const excludeKey = opts.exclude ? laneKey(opts.exclude) : laneKey(master.model)
  const servant = resolveServant(usable, opts.stored, excludeKey)
  if (!servant) {
    return {
      ok: false,
      reason:
        'LEAD and EXEC need two different models, but only one concrete healthy model is available. Add another provider or rerun /swarm ping.',
    }
  }

  return { ok: true, master, servant }
}

function resolveMaster(pool: ModelOption[], stored: StoredSwarmDefaults): SwarmLanePick | undefined {
  const storedPick = storedMatch(pool, stored?.master)
  if (storedPick) return { model: storedPick, reason: 'saved default' }

  const strong = pick(pool, isStrongLane)
  if (strong) return { model: strong, reason: 'strong-tier model' }

  const first = [...pool].sort(byLatency)[0]
  return first ? { model: first, reason: 'fastest available' } : undefined
}

function resolveServant(
  pool: ModelOption[],
  stored: StoredSwarmDefaults,
  excludeKey: string,
): SwarmLanePick | undefined {
  const candidates = pool.filter(m => laneKey(m) !== excludeKey)
  if (candidates.length === 0) return undefined

  const storedPick = storedMatch(candidates, stored?.servant)
  if (storedPick) return { model: storedPick, reason: 'saved default' }

  const fast = pick(candidates, isFastLane)
  if (fast) return { model: fast, reason: 'fast-tier model' }

  const leadProvider = excludeKey.split(':')[0]
  const otherProvider = pick(candidates, m => m.provider !== leadProvider)
  if (otherProvider) return { model: otherProvider, reason: 'independent provider' }

  const distinct = [...candidates].sort(byLatency)[0]
  return distinct ? { model: distinct, reason: 'distinct lane' } : undefined
}
