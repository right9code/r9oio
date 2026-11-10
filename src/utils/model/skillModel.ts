import type { APIProvider } from './providers.js'

function resolveProvider(provider: APIProvider | undefined): APIProvider {
  if (provider !== undefined) return provider
  // Lazy require keeps this helper usable in lightweight tests.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const providers = require('./providers.js') as typeof import('./providers.js')
  return providers.getAPIProvider()
}

export function shouldHonorSkillModelOverride(
  provider?: APIProvider,
): boolean {
  return resolveProvider(provider) === 'cursor'
}

export function resolveSkillFrontmatterModel(
  skillModel: string | undefined,
  provider?: APIProvider,
): string | undefined {
  if (!skillModel || skillModel === 'inherit') return undefined
  return shouldHonorSkillModelOverride(provider) ? skillModel : undefined
}

export function getRuntimeSkillModel(
  skillModel: string | undefined,
  provider?: APIProvider,
): string | undefined {
  if (!skillModel) return undefined
  return shouldHonorSkillModelOverride(provider) ? skillModel : undefined
}
