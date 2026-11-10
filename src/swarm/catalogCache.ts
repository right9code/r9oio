import type { ModelOption } from './modelHealth.js';

/**
 * Catalog snapshot shared between the discovery code and the typeahead.
 *
 * The typeahead runs on every keystroke in the prompt, so it must never trigger
 * discovery — `getAvailableModelOptions()` shells out to `curl` for each gateway
 * and blocks for seconds. It reads whatever the last real read already found.
 */
let cachedModels: ModelOption[] | null = null;

export function setCatalogCache(models: ModelOption[]): void {
  cachedModels = models;
}

export function clearCatalogCache(): void {
  cachedModels = null;
}

/** Last discovered gateway models. Empty before the first catalog read. */
export function peekCatalogModelOptions(): ModelOption[] {
  return cachedModels ?? [];
}

/**
 * Providers that are actually serving models right now, biggest catalog first.
 *
 * Deliberately catalog-only: a hardcoded list advertised providers this build
 * can no longer reach, so `/realping anthropic` was a guaranteed miss.
 */
export function peekCatalogProviders(): string[] {
  const counts = new Map<string, number>();
  for (const model of cachedModels ?? []) {
    counts.set(model.provider, (counts.get(model.provider) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([provider]) => provider);
}
