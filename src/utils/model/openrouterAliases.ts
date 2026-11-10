import {
  getProviderModelSet,
  PROVIDER_CONFIGS,
  type ProviderTier,
  type TierModelSet,
} from './configs.js'

type OpenRouterModelFamily = keyof TierModelSet

const OPENROUTER_TIERS = new Set<ProviderTier>(['free', 'pro', 'plus'])
const OPENROUTER_FAMILIES = new Set<OpenRouterModelFamily>(['opus', 'sonnet', 'haiku'])

type ParsedOpenRouterAlias = {
  tier?: ProviderTier
  family?: OpenRouterModelFamily
}

/**
 * Resolves Tau/OpenRouter virtual selectors such as `openrouter/free` or
 * `openrouter/pro/opus` to a concrete OpenRouter model id. Literal
 * OpenRouter model ids, including `openrouter/auto`, are left unchanged.
 */
export function resolveOpenRouterVirtualModelId(model: string): string {
  const parsed = parseOpenRouterVirtualModelId(model)
  if (!parsed) return model

  const family = parsed.family ?? 'sonnet'
  if (parsed.tier) {
    return PROVIDER_CONFIGS.openrouter?.tiers[parsed.tier]?.[family]
      ?? getProviderModelSet('openrouter')[family]
  }

  return getProviderModelSet('openrouter')[family]
}

export function isOpenRouterVirtualModelId(model: string): boolean {
  return parseOpenRouterVirtualModelId(model) !== null
}

function parseOpenRouterVirtualModelId(model: string): ParsedOpenRouterAlias | null {
  const match = /^openrouter[/:](.+)$/i.exec(model.trim())
  if (!match) return null

  const parts = match[1]
    .toLowerCase()
    .split(/[/:]/)
    .map(part => part.trim())
    .filter(Boolean)

  if (parts.length === 0) return null

  let tier: ProviderTier | undefined
  let family: OpenRouterModelFamily | undefined

  for (const part of parts) {
    if (OPENROUTER_TIERS.has(part as ProviderTier)) {
      tier = part as ProviderTier
      continue
    }
    if (OPENROUTER_FAMILIES.has(part as OpenRouterModelFamily)) {
      family = part as OpenRouterModelFamily
      continue
    }
    return null
  }

  return tier || family ? { tier, family } : null
}
