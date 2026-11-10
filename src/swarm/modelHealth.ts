import {
  clearCatalogCache,
  peekCatalogModelOptions,
  setCatalogCache,
} from './catalogCache.js';

export interface ModelOption {
  provider: string;
  modelId: string;
  label: string;
  tier?: 'opus' | 'sonnet' | 'haiku';
  latencyMs?: number;
}

export interface ModelHealthStatus {
  model: ModelOption;
  available: boolean;
  latencyMs?: number;
  error?: string;
}

/**
 * Discovers available models from configured options, current active session provider, and custom providers.
 */
// In-memory catalog cache for live custom gateways lives in catalogCache.ts so
// the prompt typeahead can read it without triggering discovery.

function getProviderAuthStore(): Record<string, string> {
  const fs = require('fs');
  const path = require('path');
  const keysPath = path.join(process.env.HOME || '', '.config', 'claude-code', 'provider-keys.json');
  if (fs.existsSync(keysPath)) {
    try {
      const parsedKeys = JSON.parse(fs.readFileSync(keysPath, 'utf-8'));
      const store = parsedKeys.keys || parsedKeys;
      const res: Record<string, string> = {};
      for (const [k, v] of Object.entries(store)) {
        res[k] = typeof v === 'string' ? v : (v as any)?.apiKey || '';
      }
      return res;
    } catch {}
  }
  return {};
}

/**
 * Bumped every time gateway discovery replaces the cached catalog, so callers
 * can tell whether their last read was refreshed.
 */
export const CATALOG_CACHE = { generation: 0 };

/** Gateway `/models` queries can return 10k+ model ids; 3s was too tight. */
const GATEWAY_CATALOG_TIMEOUT_MS = 15000;

/**
 * Discover every model this install can address.
 *
 * @param opts.refresh Drop the process-lifetime gateway cache and re-query.
 *   Without it a first discovery that failed (gateway down, slow response,
 *   bad key) would shrink the catalog for the rest of the session — which is
 *   exactly how `/realping --all` ended up probing 6 models instead of 785.
 */
export function getAvailableModelOptions(opts: { refresh?: boolean } = {}): ModelOption[] {
  const options: ModelOption[] = [];

  // Every entry is a concrete provider+model id. There used to be an
  // 'active-session-default' sentinel row here that stood for "the current
  // session lane"; it had no model id to pin, its health ping was faked with a
  // hardcoded model, and it ended up preselected as the EXEC lane. The saved
  // swarmDefaults (see laneResolver) is the supported way to keep prior picks.

  // 1. Direct Flagship Cloud Providers (Require explicit env API keys)
  if (process.env.ANTHROPIC_API_KEY) {
    options.push(
      { provider: 'anthropic', modelId: 'claude-3-7-sonnet', label: 'Claude 3.7 Sonnet (Anthropic Direct)', tier: 'sonnet' },
      { provider: 'anthropic', modelId: 'claude-3-5-haiku', label: 'Claude 3.5 Haiku (Anthropic Direct)', tier: 'haiku' },
      { provider: 'anthropic', modelId: 'claude-opus-4-8', label: 'Claude Opus 4.8 (Anthropic Direct)', tier: 'opus' },
    );
  }

  if (process.env.OPENAI_API_KEY) {
    options.push(
      { provider: 'openai', modelId: 'gpt-4o', label: 'OpenAI: GPT-4o' },
      { provider: 'openai', modelId: 'gpt-4o-mini', label: 'OpenAI: GPT-4o Mini' },
    );
  }

  // 3. Local Offline Daemons (Ollama & LM Studio)
  options.push(
    { provider: 'ollama', modelId: 'qwen2.5-coder', label: 'Ollama: Qwen 2.5 Coder (Local port 11434)' },
    { provider: 'ollama', modelId: 'llama3.3', label: 'Ollama: Llama 3.3 (Local port 11434)' },
    { provider: 'lmstudio', modelId: 'default', label: 'LM Studio: Local model (Local port 1234)' },
  );

  if (opts.refresh) clearCatalogCache();

  // 4. Return cached live models if already populated
  const cachedGatewayModels = peekCatalogModelOptions();
  if (cachedGatewayModels.length > 0) {
    options.push(...cachedGatewayModels);
    return options;
  }

  // 5. Query every configured gateway. Blocking curl keeps this API sync for
  //    callers that render synchronously (wizard, pickers); `warmCatalogCache`
  //    runs the same discovery with fetch where blocking would freeze the UI.
  const discovered = collectGatewayModelsSync();

  // Cache only a discovery that actually found gateway models. A timeout or a
  // rejected key must leave the catalog un-cached so the next call retries.
  if (discovered.length > 0) {
    setCatalogCache(discovered)
    CATALOG_CACHE.generation += 1
  }
  options.push(...discovered);
  return options;
}

interface GatewaySource {
  provider: string;
  baseUrl: string;
  apiKey: string;
  labelFor: (modelId: string) => string;
}

/** Configured gateways whose model catalogs can be listed. */
function getGatewaySources(): GatewaySource[] {
  const fs = require('fs');
  const path = require('path');
  const sources: GatewaySource[] = [];
  const keysStore = getProviderAuthStore();

  try {
    const home = process.env.HOME || '';
    const primary = path.join(home, '.claude', 'settings.json');
    const fallback = path.join(home, '.config', 'claude-code', 'settings.json');
    const settingsPath = fs.existsSync(primary) ? primary : fallback;
    if (fs.existsSync(settingsPath)) {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      for (const cp of settings.customProviders || []) {
        const id = cp.id;
        // omniroute is built in; it goes through the base-URL chain below.
        if (!id || id === 'omniroute') continue;
        const baseUrl = String(cp.baseUrl || '').replace(/\/+$/, '');
        if (!baseUrl) continue;
        const name = cp.name || id;
        sources.push({
          provider: id,
          baseUrl,
          apiKey: keysStore[id] || '',
          labelFor: modelId => `${name}: ${modelId}`,
        });
      }
    }
  } catch {}

  // Built-in OmniRoute catalog — env OMNIROUTE_BASE_URL → stored → default local
  const omnirouteUrl = (
    process.env.OMNIROUTE_BASE_URL ||
    getStoredOmnirouteBaseUrl() ||
    'http://127.0.0.1:20128/v1'
  ).replace(/\/+$/, '');
  sources.push({
    provider: 'omniroute',
    baseUrl: omnirouteUrl,
    apiKey: keysStore.omniroute || '',
    labelFor: modelId => `OmniRoute Gateway: ${modelId}`,
  });

  return sources;
}

/** Normalize a `/models` payload (`{data:[]}`, `{models:[]}`, `["id"]`). */
function toModelOptions(payload: unknown, source: GatewaySource): ModelOption[] {
  const obj = payload as { data?: unknown; models?: unknown } | null;
  const list = Array.isArray(payload) ? payload : obj?.data ?? obj?.models;
  if (!Array.isArray(list)) return [];
  const models: ModelOption[] = [];
  for (const item of list) {
    const modelId = typeof item === 'string' ? item : (item as { id?: unknown } | null)?.id;
    if (typeof modelId !== 'string' || !modelId) continue;
    models.push({ provider: source.provider, modelId, label: source.labelFor(modelId) });
  }
  return models;
}

function collectGatewayModelsSync(): ModelOption[] {
  const { spawnSync } = require('child_process');
  const models: ModelOption[] = [];
  for (const source of getGatewaySources()) {
    try {
      const authHeader = source.apiKey ? ['-H', `Authorization: Bearer ${source.apiKey}`] : [];
      const res = spawnSync('curl', ['-s', '--compressed', ...authHeader, `${source.baseUrl}/models`], {
        timeout: GATEWAY_CATALOG_TIMEOUT_MS,
        maxBuffer: 15 * 1024 * 1024,
      });
      if (res.status !== 0 || !res.stdout) continue;
      models.push(...toModelOptions(JSON.parse(res.stdout.toString('utf-8')), source));
    } catch {}
  }
  return models;
}

let _warming: Promise<boolean> | null = null;

/**
 * Populate the catalog without blocking the caller.
 *
 * The prompt typeahead and REPL startup cannot wait seconds for curl, but both
 * want model ids available. This uses fetch instead and is safe to call on a
 * keystroke: concurrent calls share one in-flight discovery.
 */
export function warmCatalogCache(): Promise<boolean> {
  if (peekCatalogModelOptions().length > 0) return Promise.resolve(false);
  if (_warming) return _warming;

  _warming = (async () => {
    const results = await Promise.allSettled(
      getGatewaySources().map(async source => {
        const headers: Record<string, string> = {};
        if (source.apiKey) headers.Authorization = `Bearer ${source.apiKey}`;
        const response = await fetch(`${source.baseUrl}/models`, {
          headers,
          signal: AbortSignal.timeout(GATEWAY_CATALOG_TIMEOUT_MS),
        });
        if (!response.ok) return [];
        return toModelOptions(await response.json(), source);
      }),
    );
    const models = results.flatMap(r => (r.status === 'fulfilled' ? r.value : []));
    if (models.length === 0) {
      _warming = null;
      return false;
    }
    setCatalogCache(models);
    CATALOG_CACHE.generation += 1;
    return true;
  })().catch(() => {
    _warming = null;
    return false;
  });

  return _warming;
}

/** Stored /provider-saved OmniRoute gateway URL (provider-keys.json). */
function getStoredOmnirouteBaseUrl(): string | null {
  try {
    const fs = require('fs');
    const path = require('path');
    const keysPath = path.join(process.env.HOME || '', '.config', 'claude-code', 'provider-keys.json');
    if (!fs.existsSync(keysPath)) return null;
    const parsed = JSON.parse(fs.readFileSync(keysPath, 'utf-8'));
    const raw = (parsed.keys || parsed).omniroute_base_url;
    return typeof raw === 'string' && raw ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Performs a real live ping request (1 token) to verify the model actually answers.
 */
export async function testModelHealth(model: ModelOption, timeoutMs = 6000): Promise<ModelHealthStatus> {
  const start = Date.now();
  try {
    // 1. Live gateway ping (OmniRoute, River, XKiro, Antigravity, DuckDuckGo-web, Cline, etc.)
    const isDirectCloud = ['anthropic', 'openai', 'gemini', 'deepseek', 'mistral', 'openrouter'].includes(model.provider) && !model.modelId.includes('/');
    if (!isDirectCloud && model.provider !== 'ollama') {
      const keysStore = getProviderAuthStore();

      // Resolve endpoint URL and key based on provider
      let targetUrl = 'http://127.0.0.1:20128/v1/chat/completions';
      let bearerKey = keysStore.omniroute || '';

      if (model.provider === 'omniroute') {
        // Built-in provider: honor the editable gateway URL chain.
        const storedUrl = getStoredOmnirouteBaseUrl();
        targetUrl = `${(process.env.OMNIROUTE_BASE_URL || storedUrl || 'http://127.0.0.1:20128/v1').replace(/\/+$/, '')}/chat/completions`;
      } else if (model.provider === 'river') {
        targetUrl = 'https://api.river.ai/v1/chat/completions';
        bearerKey = keysStore.river || '';
      } else if (model.provider === 'xkiro') {
        targetUrl = 'https://api.xkiro.com/v1/chat/completions';
        bearerKey = keysStore.xkiro || '';
      }

      // OmniRoute's local gateway usually runs unauthenticated — key optional.
      if (!bearerKey && (model.provider === 'river' || model.provider === 'xkiro')) {
        return { model, available: false, error: `No API key found for ${model.provider}` };
      }

      const res = await fetch(targetUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${bearerKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: model.modelId,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        let errMessage = `HTTP ${res.status}`;
        try {
          const errJson = JSON.parse(errText);
          errMessage = errJson.error?.message || errJson.message || errMessage;
        } catch {}
        return { model, available: false, latencyMs: Date.now() - start, error: errMessage.slice(0, 80) };
      }

      // River (and some gateways) return HTTP 200 but stream a "terminated"
      // or "error" event in the body. Read enough of the body to catch it.
      try {
        const bodySnippet = await res.text().catch(() => '');
        if (/\bterminated\b/i.test(bodySnippet) || /"error"/i.test(bodySnippet)) {
          const snippet = bodySnippet.slice(0, 120).replace(/\s+/g, ' ');
          return { model, available: false, latencyMs: Date.now() - start, error: `Stream error: ${snippet}` };
        }
      } catch { /* body read optional; silence */ }

      return {
        model,
        available: true,
        latencyMs: Date.now() - start,
      };
    }

    // 2. Local Ollama & LM Studio live ping
    if (model.provider === 'ollama') {
      const res = await fetch('http://127.0.0.1:11434/api/tags', {
        signal: AbortSignal.timeout(1200),
      });
      if (!res.ok) {
        return { model, available: false, error: 'Ollama daemon unreachable on port 11434' };
      }
      return { model, available: true, latencyMs: Date.now() - start };
    }

    if (model.provider === 'lmstudio') {
      const res = await fetch('http://127.0.0.1:1234/v1/models', {
        signal: AbortSignal.timeout(1200),
      });
      if (!res.ok) {
        return { model, available: false, error: 'LM Studio unreachable on port 1234' };
      }
      return { model, available: true, latencyMs: Date.now() - start };
    }

    // 3. Direct Flagship Cloud Providers Key check
    if (model.provider === 'openai' && !process.env.OPENAI_API_KEY) {
      return { model, available: false, error: 'OPENAI_API_KEY is not set' };
    }
    if (model.provider === 'anthropic' && !process.env.ANTHROPIC_API_KEY) {
      return { model, available: false, error: 'ANTHROPIC_API_KEY is not set' };
    }

    return {
      model,
      available: true,
      latencyMs: Date.now() - start,
    };
  } catch (err: any) {
    return {
      model,
      available: false,
      error: err?.name === 'TimeoutError' ? 'Timeout (>4.5s)' : (err?.message || 'Connection failed'),
    };
  }
}

/**
 * Tests candidate models using a high-concurrency worker pool (up to 40 in parallel)
 * and returns every model that responds successfully.
 */
export async function scanHealthyModels(candidates: ModelOption[], concurrency = 35): Promise<ModelHealthStatus[]> {
  const results: ModelHealthStatus[] = [];
  const queue = [...candidates];

  async function worker() {
    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) break;
      const status = await testModelHealth(item);
      if (status.available && status.latencyMs !== undefined) {
        status.model.latencyMs = status.latencyMs;
      }
      results.push(status);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, candidates.length) }).map(worker);
  await Promise.all(workers);
  return results;
}

/**
 * Real verification probe: ask the model a question only a working model can
 * answer, and check the answer. Unlike `testModelHealth` this does not probe a
 * gateway or check that a key exists — it runs the model itself through the
 * normal provider stack and reads its reply.
 */
export const REAL_PING_PROMPT = 'What is 2+2? Reply with only the number.'

/**
 * True when a reply contains the number 4. Accepts "4", "4.", "2+2 = 4",
 * "The answer is 4" — and rejects 14 / 40 / 400 / "4.5" style answers.
 */
export function isRealPingReplyCorrect(reply: string): boolean {
  const numbers = reply.match(/-?\d+(?:\.\d+)?/g)
  if (!numbers) return false
  return numbers.some(n => Number(n) === 4)
}

export interface RealPingStatus extends ModelHealthStatus {
  /** Raw reply text, so the table shows the evidence rather than a boolean. */
  reply?: string;
}

function extractReplyText(message: unknown): string {
  const content = (message as { content?: unknown } | null)?.content
  if (!Array.isArray(content)) return ''
  return content
    .map(block => {
      const b = block as { type?: string; text?: unknown } | null
      return b?.type === 'text' ? String(b.text ?? '') : ''
    })
    .join('')
    .trim()
}

/**
 * Send `REAL_PING_PROMPT` to one model on its own lane and check the answer.
 * Routing goes through sideQuery + runWithForcedProvider, so the probe uses the
 * same provider/client path as a real turn instead of a hand-rolled request.
 */
/**
 * Hard deadline around a probe.
 *
 * `AbortSignal.timeout` alone is not enough: several lanes build their request
 * without passing the signal through, so one unresponsive model can hold a
 * worker slot for minutes and stretch a sweep far past `timeoutMs`.
 */
function withHardTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`Timeout (>${Math.round(timeoutMs / 1000)}s)`)
      err.name = 'TimeoutError'
      reject(err)
    }, timeoutMs)
    timer.unref?.()
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  }) as Promise<T>
}

export async function realPingModel(model: ModelOption, timeoutMs = 20000): Promise<RealPingStatus> {
  const start = Date.now()
  const [
    { sideQuery },
    { runWithForcedProvider },
    { isAPIProvider },
    { isCustomProvider },
  ] = await Promise.all([
    import('../utils/sideQuery.js'),
    import('../utils/forcedProvider.js'),
    import('../utils/model/providers.js'),
    import('../utils/customProviders.js'),
  ])

  if (!isAPIProvider(model.provider) && !isCustomProvider(model.provider)) {
    return {
      model,
      available: false,
      error: `Provider '${model.provider}' cannot be pinned, so it cannot be probed per-model`,
    }
  }

  try {
    const message = await runWithForcedProvider(
      { provider: model.provider as Parameters<typeof runWithForcedProvider>[0]['provider'] },
        () =>
          withHardTimeout(
            sideQuery({
              model: model.modelId,
              max_tokens: 24,
              maxRetries: 0,
              temperature: 0,
              thinking: false,
              skipSystemPromptPrefix: true,
              querySource: 'model_validation',
              signal: AbortSignal.timeout(timeoutMs),
              messages: [{ role: 'user', content: REAL_PING_PROMPT }],
            }),
            timeoutMs,
          ),
    )

    const reply = extractReplyText(message)
    // Some lanes answer HTTP-level failures in the body. Those must never count
    // as a pass — an "API error 402: … 4 credits" string used to satisfy the
    // numeric check and reported a failing model as verified.
    const looksLikeError = /API error|error:|connection error|fetch failed/i.test(reply)
    const correct = !looksLikeError && isRealPingReplyCorrect(reply)
    return {
      model,
      available: correct,
      latencyMs: Date.now() - start,
      reply,
      error: correct
        ? undefined
        : looksLikeError
          ? reply.slice(0, 120)
          : `Wrong answer: "${reply.slice(0, 60) || '(empty reply)'}"`,
    }
  } catch (err) {
    const name = (err as { name?: string } | null)?.name
    const message = err instanceof Error ? err.message : String(err)
    return {
      model,
      available: false,
      latencyMs: Date.now() - start,
      error: name === 'TimeoutError' || name === 'AbortError'
        ? `Timeout (>${Math.round(timeoutMs / 1000)}s)`
        : message.slice(0, 80),
    }
  }
}

/**
 * Probe candidates with a bounded worker pool. Concurrency is deliberately much
 * lower than `scanHealthyModels` — every probe is a full completion.
 */
export async function scanRealPings(
  candidates: ModelOption[],
  concurrency = 8,
  timeoutMs = 20000,
): Promise<RealPingStatus[]> {
  const results: RealPingStatus[] = []
  const queue = [...candidates]

  async function worker() {
    while (queue.length > 0) {
      const item = queue.shift()
      if (!item) break
      const status = await realPingModel(item, timeoutMs)
      if (status.available && status.latencyMs !== undefined) {
        status.model.latencyMs = status.latencyMs
      }
      results.push(status)
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, candidates.length) }).map(worker)
  await Promise.all(workers)
  return results
}
