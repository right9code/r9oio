import { SwarmBackupVault } from './backupVault.js';
import { CoordinationHub } from './coordinationHub.js';
import {
  getAvailableModelOptions,
  testModelHealth,
  type ModelOption,
} from './modelHealth.js';
import { isQuotaOrRateLimitError, buildQuotaRecoveryOptions } from './quotaRecovery.js';
import {
  attachSwarmWorkerAgentId,
  clearSwarmWorkers,
  listSwarmWorkers,
  recordSwarmSpawn,
  updateSwarmWorker,
  type SwarmWorkerRecord,
  type SwarmWorkerStatus,
} from './workerRegistry.js';
import type { ToolUseContext } from '../Tool.js';
import type { CanUseToolFn } from '../hooks/useCanUseTool.js';
import type { AppState } from '../state/AppState.js';

export interface SwarmSessionConfig {
  projectObjective: string;
  masterModel: ModelOption;
  defaultServantModel: ModelOption;
  projectRoot: string;
}

export class SwarmSessionManager {
  private static instance: SwarmSessionManager | null = null;
  // Kept after endSession() so /swarm diff and /swarm restore still reach the
  // last session's backup vault even though dispatch is no longer allowed.
  private static lastInstance: SwarmSessionManager | null = null;
  public backupVault: SwarmBackupVault;
  public coordinationHub: CoordinationHub;
  public config: SwarmSessionConfig;
  /** Wall-clock start, so `/swarm status` can report session age. */
  public readonly startedAt: number;

  /**
   * Live REPL plumbing captured at session start so dispatchServantTask can
   * spawn real AgentTool workers. Optional — tests dispatch without it via
   * an injected spawner.
   */
  private dispatchContext: ToolUseContext | null = null;
  private getAppState: (() => AppState) | null = null;
  private canUseTool: CanUseToolFn | null = null;
  /** Injectable for tests — defaults to the real AgentTool.call. */
  private spawnWorker: SpawnWorkerFn = defaultSpawnWorker;
  private dispatchCounter = 0;

  private constructor(config: SwarmSessionConfig) {
    this.config = config;
    this.startedAt = Date.now();
    this.backupVault = new SwarmBackupVault(config.projectRoot);
    this.coordinationHub = new CoordinationHub(
      config.projectRoot,
      config.projectObjective,
      config.masterModel,
      config.defaultServantModel
    );
    this.registerSignalHandlers();
  }

  private registerSignalHandlers(): void {
    const cleanup = () => {
      if (this.coordinationHub) {
        this.coordinationHub.setPaused(true);
      }
      const dir = this.backupVault.getSessionDir();
      console.log(`\n🛑 [Swarm Exiting] File backups safely stored at: ${dir}`);
    };

    process.once('SIGINT', cleanup);
    process.once('SIGTERM', cleanup);
  }

  public static startSession(config: SwarmSessionConfig): SwarmSessionManager {
    // A fresh session owns a fresh worker roster — stale records from a
    // previous session must not leak into the new /swarm status table.
    clearSwarmWorkers();
    SwarmSessionManager.lastInstance = null;
    SwarmSessionManager.instance = new SwarmSessionManager(config);
    return SwarmSessionManager.instance;
  }

  public static getActiveSession(): SwarmSessionManager | null {
    return SwarmSessionManager.instance;
  }

  /**
   * The most recent session, including one that has been stopped. Used by
   * `/swarm diff` and `/swarm restore` so backups stay reachable after stop.
   */
  public static getLastSession(): SwarmSessionManager | null {
    return SwarmSessionManager.instance ?? SwarmSessionManager.lastInstance;
  }

  /**
   * Tear the session down. The master tool clamp and servant pinning are both
   * gated on getActiveSession(), so clearing the singleton releases them; the
   * coordination hub is held so no queued work resumes on a dead session.
   *
   * Worker records are left in the registry on purpose — `/swarm status` after
   * a stop still reports what the session did.
   */
  public static endSession(): boolean {
    const session = SwarmSessionManager.instance;
    if (!session) return false;
    try {
      session.coordinationHub.setPaused(true);
    } catch {}
    SwarmSessionManager.lastInstance = session;
    SwarmSessionManager.instance = null;
    return true;
  }

  /**
   * Capture the REPL plumbing needed for real servant dispatch. Called by
   * the /swarm wizard right after startSession.
   */
  public setDispatchContext(
    toolUseContext: ToolUseContext,
    getAppState: () => AppState,
    canUseTool?: CanUseToolFn,
  ): void {
    this.dispatchContext = toolUseContext;
    this.getAppState = getAppState;
    this.canUseTool = canUseTool ?? null;
  }

  /** Test hook: replace the spawner used by dispatchServantTask. */
  public setSpawnWorkerFn(fn: SpawnWorkerFn): void {
    this.spawnWorker = fn;
  }

  /** Spawner plumbing access for defaultSpawnWorker. */
  public getDispatchToolUseContext(): ToolUseContext | null {
    return this.dispatchContext;
  }

  /** Spawner plumbing access for defaultSpawnWorker. */
  public getDispatchCanUseTool(): CanUseToolFn | null {
    return this.canUseTool;
  }

  /**
   * The servant model pin current spawns should use: the session config,
   * falling back to config.swarmDefaults.servant. Exported for AgentTool's
   * swarm-pin hook so master-initiated spawns land on the servant lane.
   */
  public getActiveSwarmServantPinning(): { provider: string; modelId: string } | null {
    const servant = this.config.defaultServantModel;
    if (!servant) return null;
    // 'active-session-default' is a sentinel for the session provider, not a
    // pinnable model. Its provider may still be useful, but without a real
    // model id there is nothing to pin — let the caller's normal flow decide.
    if (servant.modelId === 'active-session-default') return null;
    return { provider: servant.provider, modelId: servant.modelId };
  }

  /**
   * Deploy a real background servant worker for one work item.
   *
   * The spawn goes through AgentTool with run_in_background + provider +
   * model_id so the servant runs on its pinned lane (NOT the master's).
   * Completion flows back into the master's conversation as a
   * <task-notification> emitted by the background-agent lifecycle.
   */
  public async dispatchServantTask(taskDescription: string): Promise<{
    ok: boolean;
    error?: string;
    task?: { id: string; subject: string };
    worker?: SwarmWorkerRecord;
  }> {
    if (this.coordinationHub.isPaused()) {
      return { ok: false, error: 'Swarm is paused — resume before dispatching.' };
    }

    const servant = this.config.defaultServantModel;
    // An unpinned servant lane cannot be dispatched: passing the sentinel as a
    // model_id would reach the provider verbatim and fail (or silently land on
    // the master's lane). Surface it instead of spawning a broken worker.
    if (!servant || servant.modelId === 'active-session-default') {
      return {
        ok: false,
        error:
          'Servant lane is not pinned to a concrete model. Re-run /swarm and pick an EXEC model.',
      };
    }
    const numericProvider = servant.provider;
    const workerName = `swarm-task-${++this.dispatchCounter}`;

    // 1. Track the work item in the coordination hub.
    const hubTask = this.coordinationHub.addTask(taskDescription, servant);
    this.coordinationHub.updateTaskStatus(hubTask.id, 'in_progress');

    // 2. Register the worker before spawning so /swarm status shows it
    //    immediately (running) even if the spawn is still in flight.
    const record: SwarmWorkerRecord = {
      name: workerName,
      provider: numericProvider,
      modelId: servant.modelId,
      taskId: hubTask.id,
      status: 'running',
      startedAt: Date.now(),
      promptSummary: taskDescription.length > 80
        ? `${taskDescription.slice(0, 77)}...`
        : taskDescription,
    };
    recordSwarmSpawn(record);

    // 3. Spawn. When live REPL plumbing is absent (headless/tests without a
    //    spawner) the worker stays registered and the spawn is skipped.
    if (!this.spawnWorker) {
      return { ok: true, task: hubTask, worker: record };
    }

    try {
      const agentId = await this.spawnWorker({
        name: workerName,
        description: taskDescription,
        prompt: buildServantPrompt(this.config.projectObjective, hubTask.id, taskDescription),
        provider: numericProvider,
        modelId: servant.modelId,
      });
      if (agentId) {
        attachSwarmWorkerAgentId(workerName, agentId);
      }
      return { ok: true, task: hubTask, worker: record };
    } catch (err) {
      this.markWorkerFailed(workerName, String(err));
      this.coordinationHub.updateTaskStatus(hubTask.id, 'failed', `Spawn failed: ${String(err)}`);
      return { ok: false, error: String(err), task: hubTask, worker: record };
    }
  }

  /**
   * Mark a worker failed and — when the death looks like quota/rate limiting —
   * roll back its files and compute recovery options.
   */
  public async markWorkerFailed(workerName: string, error: string): Promise<void> {
    const worker = listSwarmWorkers().find(w => w.name === workerName);
    updateSwarmWorker(workerName, { status: 'failed' satisfies SwarmWorkerStatus, error });
    if (!worker) return;

    const looksLikeQuota = isQuotaOrRateLimitError(new Error(error));
    if (worker.taskId) {
      if (looksLikeQuota) {
        await this.handleQuotaDeath(
          { provider: worker.provider, modelId: worker.modelId, label: `${worker.provider}:${worker.modelId}` },
          worker.taskId,
          error,
        );
      } else {
        this.coordinationHub.updateTaskStatus(worker.taskId, 'failed', error);
      }
    }
  }

  /** Mark a worker completed; verifies before completing the hub task. */
  public markWorkerCompleted(workerName: string, evidenceSummary: string): void {
    const worker = listSwarmWorkers().find(w => w.name === workerName);
    updateSwarmWorker(workerName, { status: 'completed' satisfies SwarmWorkerStatus });
    if (worker?.taskId) {
      this.coordinationHub.updateTaskStatus(worker.taskId, 'completed', undefined, {
        type: 'manual',
        summary: evidenceSummary,
      });
    }
  }

  /**
   * Reconcile the worker registry live from AppState.tasks (the background
   * agent lifecycle marks tasks completed/failed and notifies the master).
   * Returns the reconciled records for /swarm status.
   */
  public reconcileWorkers(appState?: AppState): SwarmWorkerRecord[] {
    const tasks = appState?.tasks ?? this.getAppState?.().tasks;
    const records = listSwarmWorkers();
    if (!tasks) return records;

    for (const record of records) {
      if (record.status !== 'running') continue;
      const live = record.agentId ? tasks[record.agentId] : undefined;
      const liveAny = live as { status?: string; error?: string; result?: unknown } | undefined;
      if (!liveAny) continue;
      if (liveAny.status === 'completed') {
        this.markWorkerCompleted(record.name, 'Background agent reported completion.');
      } else if (liveAny.status === 'failed') {
        void this.markWorkerFailed(record.name, liveAny.error ?? 'worker failed');
      } else if (liveAny.status === 'killed') {
        updateSwarmWorker(record.name, { status: 'failed' satisfies SwarmWorkerStatus, error: 'killed by user' });
      }
    }
    return listSwarmWorkers();
  }

  /**
   * Mark the session paused: new dispatches are blocked and the pause is
   * recorded as guidance for the LEAD. Workers already running are not
   * killed — they finish on their own unless the platform cancels them.
   */
  public pause(reason?: string): void {
    this.coordinationHub.setPaused(true);
    if (reason) {
      this.coordinationHub.addGuidance(`[EMERGENCY PAUSE]: ${reason}`);
    }
  }

  /**
   * Resumes execution after pausing.
   */
  public resume(): void {
    this.coordinationHub.setPaused(false);
  }

  /**
   * Injects non-blocking human guidance to steer the master.
   */
  public steer(guidance: string): void {
    this.coordinationHub.addGuidance(`[HUMAN STEERING]: ${guidance}`);
  }

  /**
   * Intercepts a file edit: checks file exclusivity lock and guarantees a shadow copy is safely stored in vault before edit.
   */
  public prepareFileEdit(filePath: string, taskId: string, agentName: string): { allowed: boolean; error?: string } {
    const claim = this.coordinationHub.claimFile(filePath, taskId, agentName);
    if (!claim.success) {
      return {
        allowed: false,
        error: `File '${filePath}' is currently locked by Task '${claim.holder?.taskId}' (${claim.holder?.agentName}). Concurrent edit rejected to prevent race conditions.`,
      };
    }

    this.backupVault.backupFile(filePath, agentName);
    return { allowed: true };
  }

  /**
   * Releases file locks once a task finishes or fails.
   */
  public finishTaskFiles(taskId: string): void {
    this.coordinationHub.releaseClaimsForTask(taskId);
  }

  /**
   * Handle quota exhaustion: rolls back half-written corrupted files to pristine state,
   * releases file claims, and prepares tested alternative models.
   */
  public async handleQuotaDeath(failedModel: ModelOption, taskId: string, error: any) {
    const task = this.coordinationHub.getState().tasks.find(t => t.id === taskId);
    const affectedFiles = task?.filesClaimed || [];

    // Auto-rollback corrupted / half-written files before launching replacement
    if (affectedFiles.length > 0) {
      this.backupVault.restoreFiles(affectedFiles);
    }
    this.finishTaskFiles(taskId);
    this.coordinationHub.updateTaskStatus(taskId, 'failed', `Quota death: ${String(error)}. Files rolled back to pristine.`);

    const candidates = getAvailableModelOptions().filter(
      m => m.modelId !== failedModel.modelId
    );

    // Filter alternatives
    const recovery = buildQuotaRecoveryOptions({
      taskSubject: task?.subject || 'Task',
      failedModel,
      error: String(error),
      suggestedAlternatives: candidates.slice(0, 4),
    });

    return {
      recovery,
      rolledBackFiles: affectedFiles,
    };
  }
}

/** Input a spawn implementation receives from dispatchServantTask. */
export interface ServantSpawnRequest {
  name: string;
  description: string;
  prompt: string;
  provider: string;
  modelId: string;
}

/** Returns the background agentId (AppState.tasks key) when launched. */
export type SpawnWorkerFn = (
  request: ServantSpawnRequest,
) => Promise<string | null>;

/**
 * Real spawner: launches the servant through AgentTool with run_in_background
 * so the master's conversation receives a <task-notification> on completion.
 * provider + model_id must travel together — AgentTool ignores model_id
 * unless a valid provider accompanies it, and silently drops providers that
 * fail isAPIProvider().
 */
export const defaultSpawnWorker: SpawnWorkerFn = async request => {
  const [{ AgentTool }, { createAssistantMessage }] = await Promise.all([
    import('../tools/AgentTool/AgentTool.js'),
    import('../utils/messages.js'),
  ]);
  const session = SwarmSessionManager.getActiveSession();
  const toolUseContext = session?.getDispatchToolUseContext() ?? null;
  if (!toolUseContext) {
    throw new Error(
      'No dispatch context — swarm session was not started from the wizard with live REPL plumbing.',
    );
  }
  const assistantMessage = createAssistantMessage({ content: '[swarm servant dispatch]' });
  const result = await AgentTool.call(
    {
      name: request.name,
      description: request.description.slice(0, 80),
      prompt: request.prompt,
      subagent_type: 'general-purpose',
      provider: request.provider,
      model_id: request.modelId,
      run_in_background: true,
    },
    toolUseContext,
    session!.getDispatchCanUseTool()!,
    assistantMessage,
  );
  const data = result.data as { agentId?: string };
  return data?.agentId ?? null;
};

/**
 * Build the servant worker's system-of-record prompt: the project objective,
 * its assigned hub task id (for file-claim + status bookkeeping), the work
 * item, and the coordination rules the scaffolding enforces.
 */
export function buildServantPrompt(
  objective: string,
  taskId: string,
  taskDescription: string,
): string {
  return [
    'You are an EXEC agent in the OIO harness coordinated by LEAD.',
    '',
    `PROJECT OBJECTIVE: ${objective}`,
    '',
    `YOUR ASSIGNED TASK (${taskId}):`,
    taskDescription,
    '',
    'RULES:',
    `- Do only your assigned task; do not touch others' work.`,
    '- Target file: Edit only the specific file(s) assigned to you.',
    '- DOX CONTEXT SCOPING: If an AGENTS.MD exists in your target directory, follow its localized guidelines.',
    '- TOKEN CONSERVATION: Process files incrementally one by one; do not load massive batches into memory at once.',
    '- If you encounter an unresolvable doubt, ambiguity, or missing source, do not guess: append your question into `_QUERIES.MD` with `STATUS: PENDING` and wait for LEAD guidance.',
    '- Verify your deliverable before finishing (confirm file exists, size > 0, contents correct) and include the evidence in your final summary.',
    '- End with a line: VERIFICATION: <how you verified, e.g. file check/test command + exit status>.',
    '- If you hit quota/rate limits, stop immediately and say QUOTA-DEATH plus the failing model.',
  ].join('\n');
}

/**
 * First LEAD turn after the wizard starts a session with an objective:
 * decompose the objective and dispatch several EXEC agents in parallel.
 * Spawned via /swarm task through buildServantPrompt; each lands back here as
 * a <task-notification> for review.
 */
export function buildMasterKickoffPrompt(objective: string): string {
  return [
    'You are the LEAD in the OIO harness.',
    '',
    `PROJECT OBJECTIVE: ${objective}`,
    '',
    'HARD RULE — DELEGATE, DO NOT IMPLEMENT:',
    '- You are strictly an orchestrator. Write, Edit, and Bash are stripped from your tools.',
    '- Your tools are strictly: Read/Glob/Grep to inspect the workspace, Write to emit `_TASKS.MD`, and the Agent tool to dispatch EXEC agents.',
    '- EVERY leaf deliverable must be produced by an EXEC agent you spawn.',
    '',
    'NOW, IN THIS TURN:',
    '1. Inspect the workspace or notes using Read/Glob to decompose the objective into',
    '   non-overlapping, independent units (e.g. by chapter, poem, class, or file).',
    '2. Write `_TASKS.MD` in the project root summarizing the assignments as a table:',
    '   `| TASK ID | TARGET / UNIT | ACTION | ASSIGNED EXEC | STATUS | OUTPUT FILE |`',
    '   Status codes: `TODO` · `WORKING` · `DONE` · `FAILED`',
    '3. Dispatch the EXEC agents via the Agent tool with run_in_background: true and lowercase slugs (e.g. exec-1, exec-2).',
    '   The swarm runtime pins each spawn to the EXEC lane automatically.',
    '4. Monitor progress. If an EXEC logs a question in `_QUERIES.MD`, resolve it',
    '   or escalate to the user. Review EXEC completions as <task-notification> messages arrive.',
    '',
    'RULES:',
    '- Keep EXEC agents independent; each must be able to finish without waiting on another agent.',
    '- Give each EXEC agent concise instructions and exact target file paths so prompts stay small.',
    '- End with a line: DISPATCHED: <n> EXEC agents (<task one-liner; ...>).',
  ].join('\n');
}
