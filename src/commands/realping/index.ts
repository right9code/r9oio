import type { Command } from '../../commands.js'
import type { LocalCommandCall } from '../../types/command.js'
import { getGlobalConfig } from '../../utils/config.js'

/**
 * `/realping [filter] [--concurrency N] [--sample]`
 *
 * Probes every catalog model (or every model matching `filter`) with a 2+2
 * question and reports only the ones that truly answered. A full sweep is
 * hundreds of completions, so concurrency and a short timeout matter: a sweep
 * at concurrency 12 with a 20s timeout is what made this take 13+ minutes.
 */

/** Rows per provider kept by `--sample`. */
const SAMPLE_PER_PROVIDER = 10
/** Hard cap on `--sample`. */
const SAMPLE_MAX = 120

/** Fallback parallelism when the Settings value is unset (Config → Realping). */
const DEFAULT_CONCURRENCY = 40
const MAX_CONCURRENCY = 64

/** 2+2 answers in milliseconds; a model silent this long is unusable. */
const FULL_TIMEOUT_MS = 8000
const FILTERED_TIMEOUT_MS = 12000

function parseConcurrency(argv: string[]): number | null {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    const inline = arg.match(/^--concurrency=(\d+)$/) ?? arg.match(/^-c=(\d+)$/)
    const value = inline?.[1] ?? (arg === '--concurrency' || arg === '-c' ? argv[i + 1] : undefined)
    if (value === undefined) continue
    const parsed = Number.parseInt(value, 10)
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.min(parsed, MAX_CONCURRENCY)
    }
  }
  return null
}

export const call: LocalCommandCall = async (args) => {
  const { getAvailableModelOptions, scanRealPings, REAL_PING_PROMPT } = await import(
    '../../swarm/modelHealth.js'
  )

  const argv = (args || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)

  const sample = argv.some(a => a === '--sample' || a === '-s')
  const requestedConcurrency = parseConcurrency(argv)

  // The filter is the first token that is neither a flag nor a flag's value.
  const flagValues = new Set<string>()
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === '--concurrency' || arg === '-c') {
      const next = argv[i + 1]
      if (next) flagValues.add(next)
    }
  }
  const filter = argv
    .find(a => !a.startsWith('-') && a !== 'all' && !flagValues.has(a))
    ?.toLowerCase()

  // Always re-discover: a gateway that was slow or down when the catalog was
  // first read must not reduce a sweep to "the six built-in rows".
  let candidates = getAvailableModelOptions({ refresh: true })
  const catalogSize = candidates.length
  const catalogByProvider = new Map<string, number>()
  for (const m of candidates) {
    catalogByProvider.set(m.provider, (catalogByProvider.get(m.provider) ?? 0) + 1)
  }

  if (filter) {
    candidates = candidates.filter(
      m => m.modelId.toLowerCase().includes(filter) || m.provider.toLowerCase().includes(filter),
    )
  }

  if (candidates.length === 0) {
    return {
      type: 'text',
      value: `No models matched${filter ? ` "${filter}"` : ''}. Run \`/swarmmodels\` to browse the catalog.`,
    }
  }

  // Full sweep by default; `--sample` keeps the quick interleaved version.
  let probed = candidates
  let sampleNote = ''
  if (sample) {
    const byProvider = new Map<string, typeof candidates>()
    for (const c of candidates) {
      const list = byProvider.get(c.provider)
      if (list) list.push(c)
      else byProvider.set(c.provider, [c])
    }
    const interleaved: typeof candidates = []
    for (let i = 0; i < SAMPLE_PER_PROVIDER; i++) {
      for (const list of byProvider.values()) {
        if (list[i]) interleaved.push(list[i])
      }
    }
    probed = interleaved.slice(0, SAMPLE_MAX)
    if (probed.length < candidates.length) {
      sampleNote = ` — sampled ${probed.length} of ${candidates.length}; drop \`--sample\` to probe them all`
    }
  }

  // Settings value, unless the invocation passed --concurrency explicitly.
  const storedConcurrency = getGlobalConfig().realpingConcurrency
  const concurrency =
    requestedConcurrency ??
    (typeof storedConcurrency === 'number' && storedConcurrency > 0
      ? Math.min(storedConcurrency, MAX_CONCURRENCY)
      : DEFAULT_CONCURRENCY)
  const timeoutMs = filter ? FILTERED_TIMEOUT_MS : FULL_TIMEOUT_MS
  const startedAt = Date.now()
  const results = await scanRealPings(probed, concurrency, timeoutMs)
  const elapsedSec = Math.round((Date.now() - startedAt) / 1000)

  // Only models that genuinely answered are reported. Failures stay hidden —
  // a sweep is for finding working lanes, not for dumping 700 error strings.
  const passed = results
    .filter(r => r.available)
    .sort((a, b) => (a.latencyMs ?? 0) - (b.latencyMs ?? 0))
  const silent = results.length - passed.length

  const cell = (text: string, max: number) =>
    text.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim().slice(0, max) || '-'

  const catalogSummary = [...catalogByProvider.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([p, n]) => `${p}=${n}`)
    .join(' ')
  const noGateway =
    catalogSize > 0 && !catalogByProvider.has('omniroute') && !catalogByProvider.has('xkiro')

  const lines = [
    `🧪 **Real Model Verification** — each model was asked: \`${REAL_PING_PROMPT}\`${sampleNote}`,
    `Catalog: ${catalogSize} models (${catalogSummary || 'none'}); probed ${probed.length} at concurrency ${concurrency} in ${elapsedSec}s.`,
    ...(noGateway
      ? [
          '',
          '⚠️ No gateway models in the catalog — omniroute/xkiro returned nothing. Check the gateway with `curl -s http://127.0.0.1:20128/v1/models | head`.',
        ]
      : []),
    '',
    `**Answered correctly (${passed.length}/${results.length})**${silent > 0 ? ` — ${silent} did not answer` : ''}`,
    '',
    '| Provider | Model | Reply | Latency |',
    '| :--- | :--- | :--- | :--- |',
  ]

  for (const r of passed.slice(0, 200)) {
    lines.push(
      `| ${r.model.provider} | \`${r.model.modelId}\` | ${cell(r.reply ?? '', 24)} | ${r.latencyMs}ms |`,
    )
  }
  if (passed.length === 0) {
    lines.push('| - | No model answered 2+2 correctly | - | - |')
  }
  if (passed.length > 200) {
    lines.push('', `*... and ${passed.length - 200} more working models.*`)
  }

  lines.push(
    '',
    `Tip: \`/realping <filter>\` narrows the sweep; \`--concurrency N\` trades politeness for speed (max ${MAX_CONCURRENCY}); \`--sample\` probes a small spread instead.`,
  )
  return { type: 'text', value: lines.join('\n') }
}

const realping = {
  type: 'local',
  name: 'realping',
  aliases: ['real-ping'],
  description: 'Verify models really work: asks each one 2+2 and lists the ones that answered 4',
  immediate: true,
  argumentHint: '[filter] [--concurrency N] [--sample]',
  supportsNonInteractive: true,
  load: () => import('./index.js'),
} satisfies Command

export default realping
