import * as path from 'path';
import { SwarmSessionManager } from '../../swarm/swarmManager.js';
import { getAvailableModelOptions, scanHealthyModels } from '../../swarm/modelHealth.js';
import type { ModelOption } from '../../swarm/modelHealth.js';
import { listSwarmWorkers } from '../../swarm/workerRegistry.js';
import {
  resolveSwarmLanes,
  type StoredSwarmDefaults,
  type SwarmLaneResolution,
} from '../../swarm/laneResolver.js';
import { getGlobalConfig } from '../../utils/config.js';

export interface SwarmCommandArgs {
  objective?: string;
  action?: 'start' | 'pause' | 'resume' | 'steer' | 'status' | 'restore';
  message?: string;
}

/**
 * Resolve the master/servant pair for a swarm session.
 *
 * Order: stored swarmDefaults (settings) → same-provider sibling of stored →
 * legacy heuristics. Exported for tests; `stored` may be null.
 */
export function resolveSwarmModels(
  available: ModelOption[],
  stored?: StoredSwarmDefaults,
): { master: ModelOption; servant: ModelOption } {
  const lanes = resolveSwarmLanes(available, { stored });
  if (!lanes.ok) {
    // Callers that need to report the failure should use resolveSwarmModelsResult.
    const placeholder: ModelOption = { provider: 'none', modelId: 'none', label: 'No models available' };
    return { master: placeholder, servant: placeholder };
  }
  return { master: lanes.master.model, servant: lanes.servant.model };
}

/**
 * Same resolution as `resolveSwarmModels`, but keeps the failure reason so the
 * caller can explain why no session was started instead of inventing a lane.
 */
export function resolveSwarmModelsResult(
  available: ModelOption[],
  stored?: StoredSwarmDefaults,
): SwarmLaneResolution {
  return resolveSwarmLanes(available, { stored });
}

/** Table cells must not contain raw pipes or newlines. */
function cell(text: string, max = 40): string {
  const flat = text.replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m ${total % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function formatWorkerTable(): string {
  const workers = listSwarmWorkers();
  if (workers.length === 0) {
    return 'No EXEC workers deployed yet. Dispatch one with `/swarm task <description>`.';
  }
  const lines = [
    `👷 **Deployed EXEC workers (${workers.length})**`,
    '',
    `| Worker | Model | Status | Task | Elapsed |`,
    `| :--- | :--- | :--- | :--- | :--- |`,
  ];
  for (const w of workers) {
    const statusIcon =
      w.status === 'running' ? '⏳ running' :
      w.status === 'completed' ? '✅ completed' : '❌ failed';
    const error = w.error ? ` — ${cell(w.error, 30)}` : '';
    const model = `${w.provider}:${w.modelId}`;
    lines.push(
      `| ${cell(w.name, 20)} | ${cell(model, 40)} | ${statusIcon}${error} | ${cell(w.promptSummary)} | ${formatDuration(Date.now() - w.startedAt)} |`,
    );
  }
  return lines.join('\n');
}

const SWARM_HELP = [
  '🧭 **Swarm commands**',
  '',
  '| Command | Effect |',
  '| :--- | :--- |',
  '| `/swarm` | Open the model wizard (LEAD + EXEC lanes) |',
  '| `/swarm <objective>` | Same wizard with the objective pre-filled |',
  '| `/swarm status` | Active session, workers, backups |',
  '| `/swarm task <description>` | Dispatch one EXEC worker |',
  '| `/swarm pause` | Hold workers (same as `/hold`) |',
  '| `/swarm resume` | Release held workers (same as `/release`) |',
  '| `/swarm steer <message>` | Inject guidance into the master queue |',
  '| `/swarm stop` | End the session and release the tool clamp |',
  '| `/swarm ping [filter] [--full]` | Reachability scan |',
  '| `/swarm diff` / `/swarm restore [file]` | Inspect or revert session backups |',
  '',
  'Related: `/swarmmodels`, `/swarm ping`, `/realping` (asks each model 2+2).',
].join('\n');

/**
 * Handles /swarm, /pause, and /steer user actions
 */
export async function handleSwarmCommand(action: string, args: string, projectRoot: string = process.cwd()): Promise<string> {
  const activeSession = SwarmSessionManager.getActiveSession();

  if (action === 'pause') {
    if (!activeSession) return 'No active Swarm session to pause.';
    activeSession.pause(args || 'Paused by user via /hold');
    return '⏸️ Swarm session PAUSED. Workers are held. Use `/hold`/`/release` or `/swarm steer <message>` to guide the master.';
  }

  if (action === 'steer') {
    if (!activeSession) return 'No active Swarm session to steer. Start one with `/swarm`.';
    activeSession.steer(args);
    return `🧭 Injected guidance into Master coordination queue: "${args}"`;
  }

  if (action === 'swarm') {
    const trimmed = args.trim();
    // Exact first-word routing: `startsWith` used to make `/swarm statusfoo`
    // hit the status branch and let unknown words fall through to startSession.
    const verb = (trimmed.split(/\s+/)[0] ?? '').toLowerCase();
    const rest = trimmed.slice(verb.length).trim();

    if (verb === 'help' || verb === '?') {
      return SWARM_HELP;
    }

    if (verb === 'resume' || verb === 'release') {
      if (!activeSession) return 'No active Swarm session.';
      if (!activeSession.coordinationHub.isPaused()) {
        return 'Swarm is already active and running.';
      }
      activeSession.resume();
      return [
        '🟢 **HOLD RELEASED.**',
        'EXEC workers continue; guidance and status updated in `COORDINATION.md`.',
      ].join('\n');
    }

    if (verb === 'pause' || verb === 'hold') {
      if (!activeSession) return 'No active Swarm session to pause. Start one with `/swarm`.';
      activeSession.pause(rest || 'Paused by user via /swarm pause');
      return [
        '⏸️ **Swarm is on HOLD.** New EXEC dispatches are blocked (workers already running finish on their own).',
        '',
        '**LEAD asks:** *"What would you like to do next?"*',
        '',
        'Choose an action:',
        '1. 🧭 **Steer LEAD**: `/steer <new instruction or course correction>`',
        '2. 🔄 **Swap model**: `/swarmmodels` (or `/provider`)',
        '3. ⏪ **Revert edits**: `/swarm restore`',
        '4. 🟢 **Proceed**: `/release` (or `/swarm resume`)',
      ].join('\n');
    }

    if (verb === 'steer') {
      if (!activeSession) return 'No active Swarm session to steer. Start one with `/swarm`.';
      const guidance = rest.trim();
      if (!guidance) {
        return 'Usage: `/swarm steer <guidance>` — e.g. `/swarm steer prioritize auth over db setup`.';
      }
      activeSession.steer(guidance);
      const queued = activeSession.coordinationHub.getState().userGuidanceQueue.length;
      const shown = guidance.length > 200 ? `${guidance.slice(0, 197)}…` : guidance;
      return [
        '🧭 **Guidance queued for the LEAD**',
        `> "${shown}"`,
        '',
        `Logged in \`COORDINATION.md\`; the LEAD picks it up at its next step and adapts EXEC tasks accordingly. (${queued} item${queued === 1 ? '' : 's'} queued)`,
        activeSession.coordinationHub.isPaused()
          ? '\n*(Swarm is on HOLD — `/release` when you want work to resume.)*'
          : '',
      ].join('\n');
    }

    if (verb === 'stop' || verb === 'end') {
      if (!activeSession) return 'No active Swarm session.';
      const s = activeSession.coordinationHub.getState();
      const runningWorkers = listSwarmWorkers().filter(w => w.status === 'running').length;
      const backups = activeSession.backupVault.getEntries().length;
      const backupDir =
        path.relative(activeSession.config.projectRoot, activeSession.backupVault.getSessionDir()) ||
        activeSession.backupVault.getSessionDir();
      const doneTasks = s.tasks.filter(t => t.status === 'completed').length;
      SwarmSessionManager.endSession();
      const lines = [
        '🛑 **Swarm session stopped.**',
        `- LEAD: ${s.masterModel.label} · EXEC: ${s.defaultServantModel.label}`,
        `- Tasks: ${s.tasks.length} (${doneTasks} done)`,
        `- Backups: ${backups} file${backups === 1 ? '' : 's'} at \`${backupDir}\``,
        ...(runningWorkers > 0
          ? [`- ⚠️ ${runningWorkers} EXEC worker${runningWorkers === 1 ? '' : 's'} still running; stop does not kill them.`]
          : []),
        '',
        'LEAD/EXEC pinning and the tool clamp are released — `/swarm` starts a fresh session.',
        ...(backups > 0
          ? ['Backups stay reachable: `/swarm diff` and `/swarm restore` work until the next `/swarm`.']
          : []),
      ];
      return lines.join('\n');
    }

    if (verb === 'status') {
      if (!activeSession) {
        const last = SwarmSessionManager.getLastSession();
        const lines = [
          '⚪ **No active swarm session.**',
          '',
          '`/swarm` opens the model wizard (LEAD + EXEC), `/swarm help` lists every subcommand.',
        ];
        if (last) {
          const backupDir =
            path.relative(last.config.projectRoot, last.backupVault.getSessionDir()) ||
            last.backupVault.getSessionDir();
          lines.push('', `Last session backups remain reachable: \`${backupDir}\` (use \`/swarm diff\` / \`/swarm restore\`).`);
        }
        return lines.join('\n');
      }
      const s = activeSession.coordinationHub.getState();
      // Reconcile first: worker rows below reflect the live AppState, not a
      // roster frozen at dispatch time.
      activeSession.reconcileWorkers();
      const countOf = (status: 'pending' | 'in_progress' | 'completed' | 'failed') =>
        s.tasks.filter(t => t.status === status).length;
      const taskLine =
        s.tasks.length === 0
          ? 'none queued'
          : [
              `${s.tasks.length} total`,
              `${countOf('in_progress')} in progress`,
              `${countOf('completed')} done`,
              `${countOf('pending')} pending`,
              ...(countOf('failed') > 0 ? [`${countOf('failed')} failed`] : []),
            ].join(' · ');
      const pauseReason = s.isPaused
        ? s.userGuidanceQueue
            .slice()
            .reverse()
            .find(g => g.startsWith('[EMERGENCY PAUSE]:'))
            ?.replace(/^\[EMERGENCY PAUSE\]:\s*/, '')
        : undefined;
      const backups = activeSession.backupVault.getEntries().length;
      const elapsed = formatDuration(Date.now() - activeSession.startedAt);
      const lines = [
        `🧭 **Swarm session — ${s.isPaused ? '⏸️ PAUSED' : '🟢 ACTIVE'}** · ${elapsed} elapsed`,
        '',
        `| | |`,
        `| :--- | :--- |`,
        `| Objective | ${cell(s.projectObjective, 80)} |`,
        `| LEAD | ${cell(s.masterModel.label, 50)} · \`${s.masterModel.provider}:${s.masterModel.modelId}\` |`,
        `| EXEC | ${cell(s.defaultServantModel.label, 50)} · \`${s.defaultServantModel.provider}:${s.defaultServantModel.modelId}\` |`,
        `| Tasks | ${taskLine} |`,
        `| Guidance queued | ${s.userGuidanceQueue.length} |`,
        ...(pauseReason ? [`| Pause reason | ${cell(pauseReason, 80)} |`] : []),
        `| Backups | ${backups} file${backups === 1 ? '' : 's'} · \`${path.relative(activeSession.config.projectRoot, activeSession.backupVault.getSessionDir()) || activeSession.backupVault.getSessionDir()}\` |`,
        '',
        formatWorkerTable(),
        '',
        s.isPaused
          ? 'Resume with `/swarm resume`, or steer with `/swarm steer <message>`.'
          : 'Next: `/swarm task <description>` · `/swarm steer <message>` · `/swarm diff` · `/swarm stop`.',
      ];
      return lines.join('\n');
    }

    // Manual servant deployment: /swarm task <description>.
    if (verb === 'task') {
      const description = rest.trim();
      if (!activeSession) {
        return 'No active Swarm session. Start one with `/swarm`.';
      }
      if (!description) {
        return 'Usage: `/swarm task <description>` — dispatches an EXEC worker for that work item.';
      }
      let result;
      try {
        result = await activeSession.dispatchServantTask(description);
      } catch (error) {
        return `⚠️ Dispatch failed: ${error instanceof Error ? error.message : String(error)}`;
      }
      if (!result.ok) {
        return `⚠️ Dispatch failed: ${result.error}`;
      }
      const shown = description.length > 120 ? `${description.slice(0, 117)}…` : description;
      const lines = [
        `🚀 **Dispatched EXEC worker** for task ${result.task?.id ?? ''}`,
        `> ${shown}`,
        result.worker
          ? `Worker: ${result.worker.name} on ${result.worker.provider}:${result.worker.modelId}`
          : 'Worker registered (spawn deferred — no live REPL plumbing).',
        '',
        'It appears in `/swarm status`; completion is reported back automatically.',
      ];
      return lines.join('\n');
    }

    if (verb === 'ping' || verb === 'swarmping') {
      const parts = rest ? rest.split(/\s+/) : [];
      const isFull = parts.includes('--full') || parts.includes('full') || parts.includes('-f');
      const filterTerm = parts.find(p => p !== '--full' && p !== 'full' && p !== '-f')?.toLowerCase();
      const catalog = getAvailableModelOptions({ refresh: true });
      let candidates = catalog;

      // If user provided a specific search query (like "antigravity", "river", "xkiro", "gemini", "claude")
      if (filterTerm && filterTerm !== 'all' && filterTerm !== '*') {
        candidates = candidates.filter(c =>
          c.modelId.toLowerCase().includes(filterTerm) ||
          c.provider.toLowerCase().includes(filterTerm)
        );
      } else if (!isFull) {
        // Broad fast scan: sample across each provider group
        const byProvider = new Map<string, typeof candidates>();
        for (const c of candidates) {
          const p = c.provider;
          if (!byProvider.has(p)) byProvider.set(p, []);
          byProvider.get(p)!.push(c);
        }

        const interleaved: typeof candidates = [];
        const perProvider = 25;
        for (let i = 0; i < perProvider; i++) {
          for (const [_, list] of byProvider) {
            if (list[i]) interleaved.push(list[i]);
          }
        }
        candidates = interleaved;
      }

      const totalCount = catalog.length;
      // In --full mode, test all candidates; otherwise cap at 250 for fast response
      const displayCandidates = isFull ? candidates : candidates.slice(0, 250);
      const concurrency = isFull ? 60 : 50;
      const results = await scanHealthyModels(displayCandidates, concurrency);
      const onlyReady = results.filter(r => r.available);

      const lines = [
        `🔍 **Active & Responsive Models:** (${onlyReady.length} live of ${displayCandidates.length} tested${isFull ? ' [FULL 100% SWEEP]' : ''}; ${totalCount} total registered)`,
        `*(Real parallel 1-token HTTP test. Failed or unresponsive models auto-hidden)*`,
        ``,
        `| Provider | Model ID | Status | Ping Latency | Note |`,
        `| :--- | :--- | :--- | :--- | :--- |`,
      ];
      for (const r of onlyReady) {
        const lat = r.latencyMs !== undefined ? `${r.latencyMs}ms` : '-';
        const note = r.model.tier ? `Tier: ${r.model.tier}` : 'Ready for Swarm';
        lines.push(`| ${r.model.provider} | \`${r.model.modelId}\` | ✅ Ready | ${lat} | ${note} |`);
      }

      if (onlyReady.length === 0) {
        lines.push(`| - | No models responded to live ping | ❌ None | - | Check gateway or API keys |`);
      }

      lines.push(``, `Tip: Run \`/swarm ping --full\` to ping all ${totalCount} models, or \`/swarm ping <name>\` to target a specific provider.`);
      return lines.join('\n');
    }

    if (verb === 'diff') {
      const session = activeSession ?? SwarmSessionManager.getLastSession();
      if (!session) return 'No swarm session to inspect. Start one with `/swarm`.';
      const stoppedNote = activeSession ? '' : '_(stopped session)_\n\n';
      const parts = rest.split(/\s+/);
      const target = parts[0];
      const diffs = session.backupVault.getDiffSummary(target);
      if (diffs.length === 0) return 'No file backups found for diff comparison.';
      const lines = [
        `${stoppedNote}📊 **Swarm Backup Diff Summary:**`,
        ``,
        `| File | Changed? | Backup Lines | Current Lines |`,
        `| :--- | :--- | :--- | :--- |`,
      ];
      for (const d of diffs) {
        lines.push(`| \`${d.filePath}\` | ${d.hasChanges ? '🟡 YES' : '🟢 NO'} | ${d.originalLines} | ${d.currentLines} |`);
      }
      return lines.join('\n');
    }

    if (verb === 'restore') {
      const session = activeSession ?? SwarmSessionManager.getLastSession();
      if (!session) return 'No swarm session to restore from. Start one with `/swarm`.';
      const parts = rest.split(/\s+/);
      const specificFile = parts[0];
      if (specificFile) {
        const ok = session.backupVault.restoreFile(specificFile);
        return ok
          ? `⏪ Restored '${specificFile}' back to pristine backup state.`
          : `⚠️ File '${specificFile}' was not found in backup vault.`;
      }
      const count = session.backupVault.restoreAll();
      return `⏪ Restored all ${count} files to original pristine backup state.`;
    }

    // Intent check: Conversational or informational questions don't require full swarm dispatch
    const isQuestionOrGreeting = /^(what|how|why|who|when|where|which|can you explain|hi|hello|hey|tell me)\b/i.test(trimmed);
    if (isQuestionOrGreeting && !activeSession) {
      return `💡 You asked: "${trimmed}". In Swarm Coordinator mode, you can ask direct questions without spawning subagents. If you want to start a multi-agent swarm project instead, run \`/swarm <your project goal>\` (e.g., \`/swarm Build authentication and tests\`).`;
    }

    // Anything that reaches here is an objective — but never at the cost of a
    // running session. Replacing it would silently drop its workers and backups.
    if (activeSession) {
      return [
        '⚠️ **Swarm session already active** — not replacing it.',
        `- Objective: ${activeSession.config.projectObjective}`,
        `- Master: ${activeSession.config.masterModel.label}`,
        `- Servant: ${activeSession.config.defaultServantModel.label}`,
        '',
        'Use `/swarm status` to inspect it, `/swarm steer <message>` to guide it, or `/swarm stop` to end it before starting another.',
      ].join('\n');
    }

    // Default initialization (used by headless/non-interactive callers; the
    // interactive REPL opens the wizard instead).
    const available = getAvailableModelOptions();
    const stored = getGlobalConfig().swarmDefaults ?? null;
    const lanes = resolveSwarmModelsResult(available, stored);
    if (!lanes.ok) {
      return [
        '🚫 **Swarm not started** — the LEAD/EXEC lanes could not be pinned.',
        `- Reason: ${lanes.reason}`,
        '',
        'Fix: run `/swarm ping` to check credentials, or `/swarmmodels` to browse the catalog.',
      ].join('\n');
    }
    const master = lanes.master.model;
    const servant = lanes.servant.model;

    const session = SwarmSessionManager.startSession({
      projectObjective: trimmed || 'Autonomous Master-Servant Coordination',
      masterModel: master,
      defaultServantModel: servant,
      projectRoot,
    });

    return [
      `🚀 **Swarm Coordinator Mode Initialized!**`,
      `- **Objective**: ${session.config.projectObjective}`,
      `- **Master Model**: ${session.config.masterModel.label} (${lanes.master.reason})`,
      `- **Servant Model**: ${session.config.defaultServantModel.label} (${lanes.servant.reason})`,
      `- **Coordination File**: \`COORDINATION.md\` (created)`,
      `- **File Backup Vault**: \`.tau/swarm-backups/${session.backupVault.getSessionId()}/\``,
      ``,
      `Commands available during execution:`,
      `- \`/hold\` (or \`/swarm pause\`): Hold workers`,
      `- \`/release\` (or \`/swarm resume\`): Release held workers`,
      `- \`/swarm steer <message>\`: Inject guidance into Master coordination queue`,
      `- \`/swarm status\`: View active task summary`,
      `- \`/swarm stop\`: End the session and release the tool clamp`,
      `- \`/swarm restore\`: Revert all files modified during session`,
      `- \`/swarm help\`: Full command list`,
    ].join('\n');
  }

  return 'Unknown swarm action.';
}
