/**
 * /swarm wizard — LEAD and EXEC model selection, then the objective.
 *
 * Each lane asks the same three-way question:
 *
 *   default   → the stored preferred model (or the resolver's recommendation),
 *               taken from the catalog. No network.
 *   browse    → the whole catalog in a scrollable, searchable list. No network.
 *   realping  → live sweep of the catalog at 40 parallel probes, then the
 *               responders — only models that actually answered — in the same
 *               scrollable list, each with its response time.
 *
 * The sweep is the only path that touches the network, and it runs once per
 * wizard (results are reused if you open the other lane's list). Nothing here
 * pings at open time: opening /swarm must be instant.
 *
 * In every list the preferred model is pinned to the top when it is present.
 *
 * After EXEC, the objective prompt carries the "set as preferred" toggle
 * (`[*]`) — Enter starts, Ctrl+S toggles, Esc goes back.
 *
 * Confirm submits the LEAD kickoff prompt to the REPL (shouldQuery +
 * submitNextInput) so the LEAD immediately decomposes the objective.
 *
 * Listed models must be pinnable per-spawn: built-in APIProvider ids or
 * configured custom gateways (river/xkiro/…) — both activate and route fine;
 * unknown ids would silently run on the wrong lane.
 */

import * as React from 'react'
import { useEffect, useRef, useState } from 'react'
import { Box, Text, useInput } from '../../ink.js'
import type { CommandResultDisplay } from '../../commands.js'
import type { LocalJSXCommandContext } from '../../types/command.js'
import {
  getAvailableModelOptions,
  scanHealthyModels,
  type ModelOption,
} from '../../swarm/modelHealth.js'
import { isPinnableLane, laneKey, resolveSwarmLanes } from '../../swarm/laneResolver.js'
import { SwarmSessionManager, buildMasterKickoffPrompt } from '../../swarm/swarmManager.js'
import type { SwarmWorkerRecord } from '../../swarm/workerRegistry.js'
import { isAPIProvider, setActiveProvider } from '../../utils/model/providers.js'
import { isCustomProvider } from '../../utils/customProviders.js'
import { setMainLoopModelOverride } from '../../bootstrap/state.js'
import {
  getGlobalConfig,
  saveGlobalConfig,
} from '../../utils/config.js'
import { getAPIProvider } from '../../utils/model/providers.js'
import type { APIProvider } from '../../utils/model/providers.js'

type SwarmModelChoice = { provider: string; model: string; label?: string }

type Role = 'lead' | 'exec'

const PAGE_SIZE = 12
const DEFAULT_SWEEP_CONCURRENCY = 40
const MAX_SWEEP_CONCURRENCY = 64

/**
 * Parallel probes for the realping sweep. Read from Settings (Config →
 * Realping parallel probes) so a slow link or a rate-limited gateway can be
 * dialled down without a rebuild; clamped to what the prober will honour.
 */
function sweepConcurrency(): number {
  const stored = getGlobalConfig().realpingConcurrency
  return typeof stored === 'number' && stored > 0
    ? Math.min(stored, MAX_SWEEP_CONCURRENCY)
    : DEFAULT_SWEEP_CONCURRENCY
}

type View =
  | { kind: 'menu'; role: Role; index: number }
  | { kind: 'sweep'; role: Role }
  | {
      kind: 'browse'; role: Role; source: 'catalog' | 'realping'
      filter: string; selectedIndex: number
    }
  | { kind: 'objective'; input: string }
  | {
      kind: 'result'; tone: 'success' | 'error'; message: string;
      workers?: SwarmWorkerRecord[]
    }

function getStoredSwarmDefaults(): {
  master?: { provider: string; model: string; label?: string }
  servant?: { provider: string; model: string; label?: string }
} {
  try {
    const fs = require('fs')
    const path = require('path')
    const configFile = path.join(process.env.HOME || '', '.claude.json')
    if (fs.existsSync(configFile)) {
      const data = JSON.parse(fs.readFileSync(configFile, 'utf-8'))
      if (data.swarmDefaults) return data.swarmDefaults
    }
  } catch {}
  return getGlobalConfig().swarmDefaults || {}
}

/** Pinnable catalog, deduped on provider:modelId. Cheap — cache reads only. */
function getPinnableCatalog(): ModelOption[] {
  const seen = new Set<string>()
  return getAvailableModelOptions().filter(m => {
    if (!isPinnableLane(m)) return false
    const k = laneKey(m)
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

/**
 * Shortest proof first: models that answered sort by response time, and the
 * preferred model is pinned above them when it is still in the set.
 */
function sortByLatency(models: ModelOption[]): ModelOption[] {
  return [...models].sort(
    (a, b) => (a.latencyMs ?? Number.MAX_SAFE_INTEGER) - (b.latencyMs ?? Number.MAX_SAFE_INTEGER),
  )
}

function pinPreferred(models: ModelOption[], preferred?: ModelOption): ModelOption[] {
  if (!preferred) return models
  const key = laneKey(preferred)
  const hit = models.find(m => laneKey(m) === key)
  if (!hit) return models
  return [hit, ...models.filter(m => laneKey(m) !== key)]
}

export type SwarmWizardResult = {
  master: SwarmModelChoice
  servant: SwarmModelChoice
  objective: string
  savedToSettings: boolean
}

type OnDone = (
  result?: string,
  options?: {
    display?: CommandResultDisplay
    shouldQuery?: boolean
    nextInput?: string
    submitNextInput?: boolean
  },
) => void

export function SwarmWizard({
  onDone,
  toolUseContext,
  initialObjective,
}: {
  onDone: OnDone
  toolUseContext: LocalJSXCommandContext
  initialObjective?: string
}) {
  const setAppState = toolUseContext.setAppState
  const getAppState = toolUseContext.getAppState
  const [view, setView] = useState<View>({ kind: 'menu', role: 'lead', index: 0 })
  const [forcedObjective, setForcedObjective] = useState(initialObjective?.trim() || '')
  const [objectiveInput, setObjectiveInput] = useState('')
  const [selectedLead, setSelectedLead] = useState<ModelOption | null>(null)
  const [selectedExec, setSelectedExec] = useState<ModelOption | null>(null)
  const [saveDefaults, setSaveDefaults] = useState(true)
  const [sweepTick, setSweepTick] = useState(0)

  // Live sweep results, shared by both lanes: selecting "realping" for EXEC
  // after LEAD reuses this set instead of paying for a second sweep.
  const realpingRef = useRef<ModelOption[] | null>(null)
  // Resolved once per mount: a cold catalog cache makes getPinnableCatalog()
  // spawn a blocking curl per gateway, which must not happen per keystroke.
  const catalogRef = useRef<ModelOption[] | null>(null)

  function swarmCatalog(): ModelOption[] {
    if (!catalogRef.current) catalogRef.current = getPinnableCatalog()
    return catalogRef.current
  }

  /** The preferred model for a lane: stored pick, else resolver's choice. */
  function preferredFor(role: Role, exclude?: ModelOption | null): ModelOption | undefined {
    const lanes = resolveSwarmLanes(swarmCatalog(), {
      stored: getStoredSwarmDefaults(),
      exclude: exclude ?? undefined,
    })
    if (!lanes.ok) return undefined
    return role === 'lead' ? lanes.master.model : lanes.servant.model
  }

  // Live sweep: only entered explicitly, one lane at a time.
  const sweepKey = view.kind === 'sweep' ? `${view.role}:${sweepTick}` : ''
  useEffect(() => {
    if (view.kind !== 'sweep') return
    let cancelled = false
    const role = view.role
    const run = async () => {
      try {
        const statuses = await scanHealthyModels(swarmCatalog(), sweepConcurrency())
        if (cancelled) return
        const live = sortByLatency(
          statuses.filter(s => s.available).map(s => s.model),
        )
        realpingRef.current = live
        if (live.length === 0) {
          setView({
            kind: 'result',
            tone: 'error',
            message:
              'No models answered the live sweep. Check that your gateway/provider is reachable and `/login` credentials are saved, then try again.',
          })
          return
        }
        setView({ kind: 'browse', role, source: 'realping', filter: '', selectedIndex: 0 })
      } catch (err) {
        if (!cancelled) {
          setView({ kind: 'result', tone: 'error', message: `Live sweep failed: ${String(err)}` })
        }
      }
    }
    void run()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sweepKey])

  function applyFilter(models: ModelOption[], filter: string): ModelOption[] {
    const f = filter.trim().toLowerCase()
    if (!f) return models
    return models.filter(
      m => m.modelId.toLowerCase().includes(f) || m.provider.toLowerCase().includes(f),
    )
  }

  /** Rows for the current browse view, filtered, preferred pinned on top. */
  function browseRows(view: {
    role: Role; source: 'catalog' | 'realping'; filter: string
  }): ModelOption[] {
    const all = view.source === 'realping'
      ? (realpingRef.current ?? [])
      : swarmCatalog()
    // The two lanes must be distinct, and the resolver enforces it — so the
    // model already used as LEAD is not offered as EXEC.
    const pool = view.role === 'exec' && selectedLead
      ? all.filter(m => laneKey(m) !== laneKey(selectedLead))
      : all
    const matching = applyFilter(pool, view.filter)
    const preferred = preferredFor(view.role, view.role === 'exec' ? selectedLead : null)
    return pinPreferred(matching, preferred)
  }

  function saveSwarmDefaults(lead: ModelOption, exec: ModelOption): void {
    const defaults = {
      master: { provider: lead.provider, model: lead.modelId, label: lead.label },
      servant: { provider: exec.provider, model: exec.modelId, label: exec.label },
    }
    try {
      const fs = require('fs')
      const path = require('path')
      const configFile = path.join(process.env.HOME || '', '.claude.json')
      if (fs.existsSync(configFile)) {
        const data = JSON.parse(fs.readFileSync(configFile, 'utf-8'))
        data.swarmDefaults = defaults
        fs.writeFileSync(configFile, JSON.stringify(data, null, 2), 'utf-8')
      }
    } catch {}
    saveGlobalConfig(current => ({
      ...current,
      swarmDefaults: defaults,
    }))
  }

  function startSwarmSession(lead: ModelOption, exec: ModelOption, objective: string): string {
    // LEAD lane: /models-style switch so the REPL conversation itself runs
    // on the chosen LEAD lane.
    const currentProvider = getAPIProvider()
    // Mirror /provider's custom-gateway handling: custom ids activate via the
    // same cast (provider.tsx handleActivateCustom), so a river/xkiro LEAD is
    // a legal session lane even though it's not in the static union.
    const leadProvider =
      isAPIProvider(lead.provider) || isCustomProvider(lead.provider)
        ? (lead.provider as APIProvider)
        : undefined
    if (leadProvider) {
      if (currentProvider !== leadProvider) {
        setActiveProvider(leadProvider)
      }
      // setMainLoopModelOverride writes to bootstrap STATE (synchronous),
      // which is what QueryEngine reads at request time. setAppState updates
      // the React display model — both are needed.
      if (lead.modelId) {
        setMainLoopModelOverride(lead.modelId)
      }
      setAppState(prev => ({
        ...prev,
        mainLoopModel: lead.modelId,
        mainLoopModelForSession: null,
      }))
    }

    const session = SwarmSessionManager.startSession({
      projectObjective: objective,
      masterModel: lead,
      defaultServantModel: exec,
      projectRoot: process.cwd(),
    })
    // The live session is the signal: AgentTool's swarm-pin hook and the
    // tool-pool clamp both key off SwarmSessionManager.getActiveSession(), so
    // no permission mode is entered and Shift+Tab is left untouched.
    session.setDispatchContext(toolUseContext, getAppState)
    return objective
  }

  /** Start the session and hand the LEAD kickoff to the REPL. */
  function finishSwarm(lead: ModelOption, exec: ModelOption): void {
    const objective =
      forcedObjective || objectiveInput.trim() || 'Autonomous LEAD-EXEC Coordination'
    if (saveDefaults) {
      saveSwarmDefaults(lead, exec)
    }
    startSwarmSession(lead, exec, objective)
    const kickoffPrompt = buildMasterKickoffPrompt(objective)
    const summaryMsg = [
      `Swarm active — objective: ${objective}`,
      `[LEAD]:  ${lead.provider}:${lead.modelId}`,
      `[EXEC]:  ${exec.provider}:${exec.modelId}`,
      '',
      'LEAD is inspecting workspace and emitting _TASKS.MD ledger.',
      'Live task status:   /swarm status',
      'Manual extra task:  /swarm task <description>',
    ].join('\n')

    onDone(summaryMsg, {
      display: undefined,
      shouldQuery: true,
      nextInput: kickoffPrompt,
      submitNextInput: true,
    })
  }

  /** A model was chosen for one lane. */
  function chooseModel(role: Role, model: ModelOption): void {
    if (role === 'lead') {
      setSelectedLead(model)
      setView({ kind: 'menu', role: 'exec', index: 0 })
      return
    }
    setSelectedExec(model)
    if (!selectedLead) return
    if (forcedObjective) {
      finishSwarm(selectedLead, model)
    } else {
      setObjectiveInput('')
      setView({ kind: 'objective', input: '' })
    }
  }

  function openSource(role: Role, source: 'catalog' | 'realping'): void {
    if (source === 'catalog') {
      setView({ kind: 'browse', role, source, filter: '', selectedIndex: 0 })
      return
    }
    if (realpingRef.current && realpingRef.current.length > 0) {
      setView({ kind: 'browse', role, source, filter: '', selectedIndex: 0 })
      return
    }
    setSweepTick(t => t + 1)
    setView({ kind: 'sweep', role })
  }

  // ─── Input routing ────────────────────────────────────────────

  useInput((input, key: { upArrow?: boolean; downArrow?: boolean; return?: boolean; escape?: boolean; backspace?: boolean; ctrl?: boolean; meta?: boolean }) => {
    if (view.kind === 'result') {
      if (key.return || key.escape) {
        onDone(view.message, { display: view.tone === 'error' ? 'system' : undefined })
      }
      return
    }

    if (view.kind === 'sweep') {
      if (key.escape) setView({ kind: 'menu', role: view.role, index: 2 })
      return
    }

    if (view.kind === 'objective') {
      if (key.escape) {
        setView({ kind: 'menu', role: 'exec', index: 0 })
        return
      }
      if (key.ctrl && (input === 's' || input === 'S')) {
        setSaveDefaults(prev => !prev)
        return
      }
      if (key.return) {
        if (selectedLead && selectedExec) finishSwarm(selectedLead, selectedExec)
        return
      }
      if (key.upArrow || key.downArrow) return
      if (key.backspace) {
        setObjectiveInput(prev => prev.slice(0, -1))
        return
      }
      // Paste arrives as one multi-char input event; chars as single-char
      // events. Accept both — any printable burst appends.
      if (input && input.length >= 1 && input >= ' ' && !key.ctrl && !key.meta) {
        setObjectiveInput(prev => prev + input)
      }
      return
    }

    if (view.kind === 'menu') {
      if (key.escape) {
        if (view.role === 'exec') {
          setSelectedExec(null)
          setView({ kind: 'menu', role: 'lead', index: 0 })
        } else {
          onDone('Swarm cancelled.', { display: 'system' })
        }
        return
      }
      if (key.upArrow) { setView({ ...view, index: (view.index + 2) % 3 }); return }
      if (key.downArrow) { setView({ ...view, index: (view.index + 1) % 3 }); return }
      const pick = key.return ? view.index : /^[123]$/.test(input) ? Number(input) - 1 : -1
      if (pick === -1) return
      if (pick === 0) {
        const preferred = preferredFor(view.role, view.role === 'exec' ? selectedLead : null)
        if (preferred) chooseModel(view.role, preferred)
        return
      }
      if (pick === 1) { openSource(view.role, 'catalog'); return }
      openSource(view.role, 'realping')
      return
    }

    // browse views (LEAD / EXEC)
    const rows = browseRows(view)
    const wrap = (delta: number) => {
      const n = Math.max(rows.length, 1)
      return (view.selectedIndex + delta + n) % n
    }
    if (key.escape) {
      setView({ kind: 'menu', role: view.role, index: view.source === 'realping' ? 2 : 1 })
      return
    }
    if (input === 'r' && !view.filter && view.source === 'realping') {
      realpingRef.current = null
      setSweepTick(t => t + 1)
      setView({ kind: 'sweep', role: view.role })
      return
    }
    if (key.upArrow) { setView({ ...view, selectedIndex: wrap(-1) }); return }
    if (key.downArrow) { setView({ ...view, selectedIndex: wrap(1) }); return }

    if (key.return) {
      const chosen = rows[view.selectedIndex]
      if (!chosen) return
      chooseModel(view.role, chosen)
      return
    }

    // Type-to-filter (accept paste bursts too).
    if (input && input.length >= 1 && input >= ' ' && !key.ctrl && !key.meta) {
      setView({ ...view, filter: view.filter + input, selectedIndex: 0 })
      return
    }
    if (input === '' && view.filter) {
      // Backspace arrives as input '' with key.backspace — not all terminals
      // set it; treat plain '' input as backspace only when a filter exists.
      setView({ ...view, filter: view.filter.slice(0, -1), selectedIndex: 0 })
    }
  })

  // ─── Render ──────────────────────────────────────────────────

  const laneSummary = (
    <Box flexDirection="column" marginBottom={1}>
      {selectedLead && (
        <Text dimColor>[LEAD]: {selectedLead.provider}:{selectedLead.modelId}</Text>
      )}
      {selectedExec && (
        <Text dimColor>[EXEC]: {selectedExec.provider}:{selectedExec.modelId}</Text>
      )}
    </Box>
  )

  if (view.kind === 'result') {
    return (
      <Box flexDirection="column" paddingLeft={1}>
        <Text bold color={view.tone === 'error' ? 'error' : 'success'}>
          {view.tone === 'error' ? 'Swarm' : 'Swarm started'}
        </Text>
        <Text>{view.message}</Text>
        <Box marginTop={1}>
          <Text dimColor>Enter to close</Text>
        </Box>
      </Box>
    )
  }

  if (view.kind === 'sweep') {
    return (
      <Box flexDirection="column" paddingLeft={1}>
        <Text bold>Swarm — {view.role === 'lead' ? 'LEAD' : 'EXEC'} model</Text>
        <Text>Live sweep of the catalog at {sweepConcurrency()} parallel probes…</Text>
        <Text dimColor>Only models that answer will be listed, each with its response time.</Text>
        <Box marginTop={1}>
          <Text dimColor>Esc to cancel</Text>
        </Box>
      </Box>
    )
  }

  if (view.kind === 'objective') {
    const objectiveText =
      forcedObjective || objectiveInput.trim() || 'Autonomous LEAD-EXEC Coordination'
    return (
      <Box flexDirection="column" paddingLeft={1}>
        <Text bold>Swarm — objective</Text>
        {laneSummary}
        <Text dimColor>Type the objective, then Enter to start.</Text>
        <Text>{'> '}{objectiveInput}</Text>
        <Text dimColor>Will run: {objectiveText}</Text>
        <Box marginTop={1}>
          <Text>
            {saveDefaults ? '[*]' : '[ ]'} Set as preferred LEAD/EXEC (Ctrl+S to toggle)
          </Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>Enter start · Ctrl+S toggle · Esc back</Text>
        </Box>
      </Box>
    )
  }

  if (view.kind === 'menu') {
    const preferred = preferredFor(view.role, view.role === 'exec' ? selectedLead : null)
    const catalogSize = view.role === 'exec' && selectedLead
      ? swarmCatalog().filter(m => laneKey(m) !== laneKey(selectedLead)).length
      : swarmCatalog().length
    const sweeps = realpingRef.current?.length
    const items = [
      preferred
        ? `Default — ${preferred.provider}:${preferred.modelId}`
        : 'Default — no preferred model available',
      `Browse all models — ${catalogSize} in catalog`,
      sweeps !== undefined
        ? `Realping — ${sweeps} live (sweep again with r)`
        : `Realping — sweep the catalog live at ${sweepConcurrency()} parallel`,
    ]
    return (
      <Box flexDirection="column" paddingLeft={1}>
        <Text bold>Swarm — {view.role === 'lead' ? 'LEAD' : 'EXEC'} model</Text>
        {laneSummary}
        <Text dimColor>
          {view.role === 'lead'
            ? 'LEAD plans, partitions the work and oversees the EXEC agents.'
            : 'EXEC runs the focused tasks the LEAD assigns.'}
        </Text>
        <Box flexDirection="column" marginTop={1}>
          {items.map((label, i) => {
            const selected = i === view.index
            const disabled = i === 0 && !preferred
            return (
              <Text
                key={label}
                bold={selected}
                color={selected ? 'claude' : undefined}
                dimColor={!selected}
              >
                {selected ? '>' : ' '} {i + 1}. {label}
                {disabled ? ' (press 2 or 3)' : ''}
              </Text>
            )
          })}
        </Box>
        <Box marginTop={1}>
          <Text dimColor>
            ↑↓ navigate · Enter select · Esc {view.role === 'exec' ? 'back' : 'cancel'}
          </Text>
        </Box>
      </Box>
    )
  }

  // browse views
  const rows = browseRows(view)
  const preferred = preferredFor(view.role, view.role === 'exec' ? selectedLead : null)
  // Pinning reorders rows without changing their count.
  const total = rows.length

  // Sliding window for smooth scrolling navigation
  let startIndex = 0
  if (total > PAGE_SIZE) {
    if (view.selectedIndex < Math.floor(PAGE_SIZE / 2)) {
      startIndex = 0
    } else if (view.selectedIndex > total - Math.ceil(PAGE_SIZE / 2)) {
      startIndex = total - PAGE_SIZE
    } else {
      startIndex = view.selectedIndex - Math.floor(PAGE_SIZE / 2)
    }
  }
  const visibleSlice = rows.slice(startIndex, startIndex + PAGE_SIZE)

  return (
    <Box flexDirection="column" paddingLeft={1}>
      <Text bold>
        Swarm — {view.role === 'lead' ? 'LEAD' : 'EXEC'} model
        {' '}
        <Text dimColor>
          ({view.source === 'realping' ? 'live, answered' : 'catalog'})
        </Text>
      </Text>
      {laneSummary}
      {preferred && (
        <Text dimColor>Preferred: {preferred.provider}:{preferred.modelId}</Text>
      )}
      {view.filter && <Text dimColor>filter: "{view.filter}"</Text>}
      <Box flexDirection="column" marginTop={1}>
        {visibleSlice.map((m, relativeIdx) => {
          const absoluteIdx = startIndex + relativeIdx
          const isSelected = absoluteIdx === view.selectedIndex
          const isPreferred = preferred !== undefined && laneKey(m) === laneKey(preferred)
          const badge = isPreferred ? ' ★ [DEFAULT]' : ''
          // Only the live sweep vouches for a response time; catalog rows may
          // carry a stale value from an earlier ping in this session.
          const latencyStr =
            view.source === 'realping' && m.latencyMs ? ` (${m.latencyMs}ms)` : ''
          return (
            <Text
              key={laneKey(m)}
              bold={isSelected || isPreferred}
              color={isSelected ? 'claude' : isPreferred ? 'warning' : undefined}
              dimColor={!isSelected && !isPreferred}
            >
              {isSelected ? '>' : ' '} {`${m.provider}`.padEnd(12)} {m.modelId}
              {badge && <Text color="warning">{badge}</Text>}
              <Text color={latencyStr && m.latencyMs! < 1000 ? 'success' : undefined} dimColor={!isSelected}>
                {latencyStr}
              </Text>
            </Text>
          )
        })}
        {total === 0 && (
          <Text dimColor>
            No models match "{view.filter}".
            {' '}Backspace to clear, Esc for the menu.
          </Text>
        )}
        {total > PAGE_SIZE && (
          <Text dimColor>
            Viewing {startIndex + 1}-{Math.min(startIndex + PAGE_SIZE, total)} of {total} (use ↑↓ to scroll, type to filter)
          </Text>
        )}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>
          ↑↓ navigate · type to filter · Enter select
          {view.source === 'realping' ? ' · r re-sweep' : ''} · Esc back
        </Text>
      </Box>
    </Box>
  )
}
