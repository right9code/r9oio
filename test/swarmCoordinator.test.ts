import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { SwarmBackupVault } from '../src/swarm/backupVault.js';
import { CoordinationHub } from '../src/swarm/coordinationHub.js';
import { SwarmSessionManager, buildServantPrompt, buildMasterKickoffPrompt } from '../src/swarm/swarmManager.js';
import { resolveSwarmLanes } from '../src/swarm/laneResolver.js';
import { isRealPingReplyCorrect } from '../src/swarm/modelHealth.js';
import { handleSwarmCommand, resolveSwarmModels } from '../src/commands/swarm/index.js';
import {
  clearSwarmWorkers,
  getSwarmWorker,
  listSwarmWorkers,
} from '../src/swarm/workerRegistry.js';
import { getGlobalConfig, saveGlobalConfig } from '../src/utils/config.js';
import type { ModelOption } from '../src/swarm/modelHealth.js';

describe('Swarm Coordinator System', () => {
  const testRoot = path.join('/tmp', 'tau-swarm-unit-test');
  const dummyFile = path.join(testRoot, 'dummy.txt');

  beforeEach(() => {
    fs.mkdirSync(testRoot, { recursive: true });
    fs.writeFileSync(dummyFile, 'Original pristine content', 'utf-8');
  });

  afterEach(() => {
    if (fs.existsSync(testRoot)) {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
  });

  test('BackupVault preserves original content and restores reliably', () => {
    const vault = new SwarmBackupVault(testRoot);
    const entry = vault.backupFile(dummyFile, 'worker-agent-1');
    expect(entry).not.toBeNull();

    // Modify file
    fs.writeFileSync(dummyFile, 'Modified by autonomous agent', 'utf-8');
    expect(fs.readFileSync(dummyFile, 'utf-8')).toBe('Modified by autonomous agent');

    // Revert file
    const ok = vault.restoreFile(dummyFile);
    expect(ok).toBe(true);
    expect(fs.readFileSync(dummyFile, 'utf-8')).toBe('Original pristine content');

    // Purge vault
    vault.purge();
    expect(fs.existsSync(vault.getSessionDir())).toBe(false);
  });

  test('CoordinationHub renders Markdown properly and tracks Q&A', () => {
    const dummyModel = { provider: 'anthropic', modelId: 'claude-3-7-sonnet', label: 'Claude 3.7 Sonnet' };
    const hub = new CoordinationHub(testRoot, 'Build feature X', dummyModel, dummyModel);

    hub.addTask('Write API schema');
    hub.postQuestion('Servant-1', 'Should we use TypeScript interfaces or types?');
    hub.answerQuestion(0, 'Use TypeScript interfaces.');

    const coordMdPath = path.join(testRoot, 'COORDINATION.md');
    expect(fs.existsSync(coordMdPath)).toBe(true);

    const content = fs.readFileSync(coordMdPath, 'utf-8');
    expect(content).toContain('Project Swarm Coordination Hub');
    expect(content).toContain('Write API schema');
    expect(content).toContain('Should we use TypeScript interfaces or types?');
    expect(content).toContain('Use TypeScript interfaces.');
  });

  test('Swarm commands /pause and /steer update state', async () => {
    const initRes = await handleSwarmCommand('swarm', 'Build user auth', testRoot);
    expect(initRes).toContain('Swarm Coordinator Mode Initialized');

    const steerRes = await handleSwarmCommand('steer', 'Focus on password hashing first', testRoot);
    expect(steerRes).toContain('Injected guidance');

    const pauseRes = await handleSwarmCommand('pause', 'Reviewing intermediate work', testRoot);
    expect(pauseRes).toContain('PAUSED');

    const coordMdPath = path.join(testRoot, 'COORDINATION.md');
    const content = fs.readFileSync(coordMdPath, 'utf-8');
    expect(content).toContain('Focus on password hashing first');
    expect(content).toContain('PAUSED');
  }, 10000);

  test('File exclusivity lock prevents concurrent overwrites', () => {
    const dummyModel = { provider: 'anthropic', modelId: 'claude-3-7-sonnet', label: 'Claude 3.7 Sonnet' };
    const session = SwarmSessionManager.startSession({
      projectObjective: 'Test Concurrency',
      masterModel: dummyModel,
      defaultServantModel: dummyModel,
      projectRoot: testRoot,
    });

    const fileA = path.join(testRoot, 'shared.ts');
    fs.writeFileSync(fileA, 'initial', 'utf-8');

    // Agent 1 claims file for Task 1
    const res1 = session.prepareFileEdit(fileA, 'task-1', 'agent-alpha');
    expect(res1.allowed).toBe(true);

    // Agent 2 attempts to claim same file for Task 2 concurrently -> must be rejected
    const res2 = session.prepareFileEdit(fileA, 'task-2', 'agent-beta');
    expect(res2.allowed).toBe(false);
    expect(res2.error).toContain('currently locked by Task \'task-1\'');

    // Finish task 1 -> releases claim
    session.finishTaskFiles('task-1');

    // Now Agent 2 can claim
    const res3 = session.prepareFileEdit(fileA, 'task-2', 'agent-beta');
    expect(res3.allowed).toBe(true);
  });

  test('Quota death triggers automatic rollback of touched files', async () => {
    const dummyModel = { provider: 'anthropic', modelId: 'claude-3-7-sonnet', label: 'Claude 3.7 Sonnet' };
    const session = SwarmSessionManager.startSession({
      projectObjective: 'Test Quota Failure',
      masterModel: dummyModel,
      defaultServantModel: dummyModel,
      projectRoot: testRoot,
    });

    const fileCorrupt = path.join(testRoot, 'corrupted.ts');
    fs.writeFileSync(fileCorrupt, 'PRISTINE STATE', 'utf-8');

    const task = session.coordinationHub.addTask('Write big file');
    session.prepareFileEdit(fileCorrupt, task.id, 'worker-1');

    // Simulate corrupted/half-written edit before quota death
    fs.writeFileSync(fileCorrupt, 'HALF-WRITTEN BROKEN SYNTAX...', 'utf-8');

    // Trigger quota death
    const result = await session.handleQuotaDeath(dummyModel, task.id, '429 Insufficient Quota');
    expect(result.rolledBackFiles).toContain(path.resolve(fileCorrupt));

    // Verify file was restored to pristine state automatically
    expect(fs.readFileSync(fileCorrupt, 'utf-8')).toBe('PRISTINE STATE');
  });

  test('/swarm ping or models lists live status', async () => {
    const res = await handleSwarmCommand('swarm', 'ping antigravity', testRoot);
    expect(res).toContain('Active & Responsive Models');
  }, 10000);

  test('Granular file rollback and diff inspection', async () => {
    const vault = new SwarmBackupVault(testRoot);
    const file1 = path.join(testRoot, 'file1.txt');
    const file2 = path.join(testRoot, 'file2.txt');
    fs.writeFileSync(file1, 'file1 orig', 'utf-8');
    fs.writeFileSync(file2, 'file2 orig', 'utf-8');

    vault.backupFile(file1, 'agent-1');
    vault.backupFile(file2, 'agent-1');

    fs.writeFileSync(file1, 'file1 modified', 'utf-8');
    fs.writeFileSync(file2, 'file2 modified', 'utf-8');

    const diffs = vault.getDiffSummary();
    expect(diffs.length).toBe(2);
    expect(diffs[0].hasChanges).toBe(true);

    // Granular rollback of only file1
    vault.restoreFile(file1);
    expect(fs.readFileSync(file1, 'utf-8')).toBe('file1 orig');
    expect(fs.readFileSync(file2, 'utf-8')).toBe('file2 modified');
  });

  test('Verification gate blocks task completion without evidence', () => {
    const dummyModel = { provider: 'anthropic', modelId: 'claude-3-7-sonnet', label: 'Claude 3.7 Sonnet' };
    const hub = new CoordinationHub(testRoot, 'Verification gate test', dummyModel, dummyModel);
    const task = hub.addTask('Write unit tests');

    // Attempt completion without verification evidence -> rejected
    const unverifiedRes = hub.updateTaskStatus(task.id, 'completed', 'I think it is done');
    expect(unverifiedRes.success).toBe(false);
    expect(unverifiedRes.error).toContain('without verification evidence');

    // Completion with test verification evidence -> accepted
    const verifiedRes = hub.updateTaskStatus(task.id, 'completed', 'Tests written', {
      type: 'test',
      summary: '5/5 unit tests passed with exit code 0',
    });
    expect(verifiedRes.success).toBe(true);
  });

  test('Ping-pong limiter triggers human escalation hold', () => {
    const dummyModel = { provider: 'anthropic', modelId: 'claude-3-7-sonnet', label: 'Claude 3.7 Sonnet' };
    const hub = new CoordinationHub(testRoot, 'Ping pong test', dummyModel, dummyModel);

    // Question 1
    const q1 = hub.postQuestion('Servant-A', 'First question?');
    expect(q1.allowed).toBe(true);

    // Question 2
    const q2 = hub.postQuestion('Servant-A', 'Second question?');
    expect(q2.allowed).toBe(true);

    // Question 3 without answers -> triggers automatic human escalation hold
    const q3 = hub.postQuestion('Servant-A', 'Third question?');
    expect(q3.allowed).toBe(false);
    expect(q3.escalationMessage).toContain('Excessive Q&A Ping-Pong detected');
    expect(hub.isPaused()).toBe(true);
  });

  // ─── Servant dispatch + worker registry ───────────────────────

  const servantModel: ModelOption = { provider: 'omniroute', modelId: 'deepseek-v3.1', label: 'OmniRoute: deepseek-v3.1' };
  const masterModel: ModelOption = { provider: 'omniroute', modelId: 'claude-sonnet-4-6', label: 'OmniRoute: claude-sonnet-4-6' };

  test('dispatchServantTask spawns pinned background worker and registers it', async () => {
    clearSwarmWorkers();
    const spawned: Array<Record<string, unknown>> = [];
    const session = SwarmSessionManager.startSession({
      projectObjective: 'Build auth module',
      masterModel,
      defaultServantModel: servantModel,
      projectRoot: testRoot,
    });
    session.setSpawnWorkerFn(async req => {
      spawned.push({ ...req });
      return 'agent-123';
    });

    const result = await session.dispatchServantTask('Write the login endpoint');
    expect(result.ok).toBe(true);

    // Pinned spawn: provider + model_id + run_in_background + stable name.
    expect(spawned.length).toBe(1);
    expect(spawned[0].provider).toBe('omniroute');
    expect(spawned[0].modelId).toBe('deepseek-v3.1');
    expect(spawned[0].name).toBe('swarm-task-1');
    expect(String(spawned[0].prompt)).toContain('Build auth module');
    expect(String(spawned[0].prompt)).toContain('Write the login endpoint');
    expect(buildServantPrompt('Obj', 'task-1', 'desc')).toContain('VERIFICATION:');

    // Registry: running worker bound to hub task and agentId.
    const worker = getSwarmWorker('swarm-task-1');
    expect(worker).toBeDefined();
    expect(worker!.status).toBe('running');
    expect(worker!.agentId).toBe('agent-123');
    expect(worker!.taskId).toBe(result.task?.id);

    // Hub task moved to in_progress.
    const hubTask = session.coordinationHub.getState().tasks.find(t => t.id === result.task?.id);
    expect(hubTask?.status).toBe('in_progress');
  });

  test('reconcileWorkers maps completed AppState task to completed registry record', async () => {
    clearSwarmWorkers();
    const session = SwarmSessionManager.startSession({
      projectObjective: 'Reconcile test',
      masterModel,
      defaultServantModel: servantModel,
      projectRoot: testRoot,
    });
    session.setSpawnWorkerFn(async () => 'agent-xyz');
    const result = await session.dispatchServantTask('Do reconcilable work');

    // Live AppState reports the background agent as completed.
    const appState = { tasks: { 'agent-xyz': { status: 'completed' } } } as never;
    const records = session.reconcileWorkers(appState);
    const worker = records.find(w => w.name === 'swarm-task-1');
    expect(worker?.status).toBe('completed');

    // Hub task completed WITH evidence (verification gate satisfied).
    const hubTask = session.coordinationHub.getState().tasks.find(t => t.id === result.task?.id);
    expect(hubTask?.status).toBe('completed');
    expect(hubTask?.notes).toContain('Verified');

    // /swarm status renders the worker table.
    const status = await handleSwarmCommand('swarm', 'status', testRoot);
    expect(status).toContain('swarm-task-1');
    expect(status).toContain('completed');
    clearSwarmWorkers();
  });

  test('dispatch refused while paused', async () => {
    const session = SwarmSessionManager.startSession({
      projectObjective: 'Paused dispatch test',
      masterModel,
      defaultServantModel: servantModel,
      projectRoot: testRoot,
    });
    session.setSpawnWorkerFn(async () => 'agent-never');
    session.pause('hold everything');

    const result = await session.dispatchServantTask('Work while paused');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('paused');
    expect(listSwarmWorkers().length).toBe(0);
    session.resume();
    clearSwarmWorkers();
  });

  test('worker failure with quota error routes through handleQuotaDeath', async () => {
    clearSwarmWorkers();
    const pristine = path.join(testRoot, 'quota-worker.txt');
    fs.writeFileSync(pristine, 'PRISTINE', 'utf-8');

    const session = SwarmSessionManager.startSession({
      projectObjective: 'Quota worker test',
      masterModel,
      defaultServantModel: servantModel,
      projectRoot: testRoot,
    });
    session.setSpawnWorkerFn(async () => 'agent-quota');
    const result = await session.dispatchServantTask('Work that will die');
    expect(result.ok).toBe(true);

    // Claim a file under this task, then corrupt it.
    session.prepareFileEdit(pristine, result.task!.id, 'swarm-task-1');
    fs.writeFileSync(pristine, 'HALF-WRITTEN', 'utf-8');

    // Registry reports failure with a 429 — reconcile routes to quota death.
    const appState = { tasks: { 'agent-quota': { status: 'failed', error: '429 insufficient_quota' } } } as never;
    await session.reconcileWorkers(appState);

    const worker = getSwarmWorker('swarm-task-1');
    expect(worker?.status).toBe('failed');

    // Quota death rolled the file back and failed the hub task.
    expect(fs.readFileSync(pristine, 'utf-8')).toBe('PRISTINE');
    const hubTask = session.coordinationHub.getState().tasks.find(t => t.id === result.task?.id);
    expect(hubTask?.status).toBe('failed');
    expect(hubTask?.notes).toContain('Quota death');
    clearSwarmWorkers();
  });

  test('resolveSwarmModels prefers stored swarmDefaults then heuristics', () => {
    const available: ModelOption[] = [
      { provider: 'omniroute', modelId: 'claude-sonnet-4-6', label: 'sonnet', tier: 'sonnet' },
      { provider: 'omniroute', modelId: 'deepseek-v3.1', label: 'deepseek' },
      { provider: 'antigravity', modelId: 'gemini-3-pro', label: 'opus', tier: 'opus' },
    ];

    // 1. Stored defaults win when still present in the catalog.
    const r1 = resolveSwarmModels(available, {
      master: { provider: 'antigravity', model: 'gemini-3-pro' },
      servant: { provider: 'omniroute', model: 'deepseek-v3.1' },
    });
    expect(r1.master.modelId).toBe('gemini-3-pro');
    expect(r1.servant.modelId).toBe('deepseek-v3.1');

    // 2. A stored lane that is not in the catalog is ignored.
    const r2 = resolveSwarmModels(available, {
      master: { provider: 'river', model: 'claude-opus-4-8' },
      servant: { provider: 'river', model: 'deepseek-v3.1' },
    });
    expect(['omniroute', 'antigravity']).toContain(r2.master.provider);

    // 3. No stored defaults → heuristics.
    const r3 = resolveSwarmModels(available, null);
    expect(r3.master.tier).toBe('sonnet');
    expect(r3.servant.modelId).toContain('deepseek');

    // 4. The session-default sentinel is never chosen as the servant, even
    //    when a stale swarmDefaults pinned it — it has no model id to pin.
    const withSentinel: ModelOption[] = [
      { provider: 'omniroute', modelId: 'active-session-default', label: 'active' },
      ...available,
    ];
    const r4 = resolveSwarmModels(withSentinel, {
      servant: { provider: 'omniroute', model: 'active-session-default' },
    });
    expect(r4.servant.modelId).not.toBe('active-session-default');
  });

  test('resolveSwarmLanes enforces concrete, distinct, healthy lanes', () => {
    const catalog: ModelOption[] = [
      { provider: 'omniroute', modelId: 'active-session-default', label: 'sentinel' },
      { provider: 'omniroute', modelId: 'claude-sonnet-4-6', label: 'sonnet', tier: 'sonnet' },
      { provider: 'omniroute', modelId: 'deepseek-v4-flash', label: 'flash' },
    ];

    // Happy path: real ids, two different lanes, sentinel never selected.
    const ok = resolveSwarmLanes(catalog, {});
    expect(ok.ok).toBe(true);
    if (!ok.ok) throw new Error(ok.reason);
    expect(ok.master.model.modelId).not.toBe('active-session-default');
    expect(ok.servant.model.modelId).not.toBe('active-session-default');
    expect(`${ok.master.model.provider}:${ok.master.model.modelId}`).not.toBe(
      `${ok.servant.model.provider}:${ok.servant.model.modelId}`,
    );

    // One healthy model cannot fill both roles.
    const single = resolveSwarmLanes(catalog, {
      healthy: [{ provider: 'omniroute', modelId: 'claude-sonnet-4-6', label: 'sonnet' }],
    });
    expect(single.ok).toBe(false);

    // The EXEC lane is kept off an explicitly excluded LEAD lane.
    const excluded = resolveSwarmLanes(catalog, {
      exclude: { provider: 'omniroute', modelId: 'claude-sonnet-4-6', label: 'sonnet' },
    });
    expect(excluded.ok).toBe(true);
    if (!excluded.ok) throw new Error(excluded.reason);
    expect(excluded.servant.model.modelId).not.toBe('claude-sonnet-4-6');

    // Only sentinels → fail with a reason instead of inventing a lane.
    const empty = resolveSwarmLanes([
      { provider: 'omniroute', modelId: 'active-session-default', label: 'sentinel' },
    ]);
    expect(empty.ok).toBe(false);
    if (empty.ok) throw new Error('expected failure');
    expect(empty.reason.length).toBeGreaterThan(0);
  });

  test('isRealPingReplyCorrect only accepts a real 4', () => {
    expect(isRealPingReplyCorrect('4')).toBe(true);
    expect(isRealPingReplyCorrect(' 4. ')).toBe(true);
    expect(isRealPingReplyCorrect('The answer is 4.')).toBe(true);
    expect(isRealPingReplyCorrect('2+2 = 4')).toBe(true);
    expect(isRealPingReplyCorrect('4.0')).toBe(true);
    expect(isRealPingReplyCorrect('14')).toBe(false);
    expect(isRealPingReplyCorrect('40')).toBe(false);
    expect(isRealPingReplyCorrect('4.5')).toBe(false);
    expect(isRealPingReplyCorrect('I cannot answer that.')).toBe(false);
  });

  test('swarmDefaults config round-trip', () => {
    saveGlobalConfig(current => ({
      ...current,
      swarmDefaults: {
        master: { provider: 'omniroute', model: 'claude-sonnet-4-6', label: 'test-master' },
        servant: { provider: 'ollama', model: 'qwen2.5-coder', label: 'test-servant' },
      },
    }));
    const readBack = getGlobalConfig().swarmDefaults;
    expect(readBack?.master.model).toBe('claude-sonnet-4-6');
    expect(readBack?.servant.provider).toBe('ollama');
    // Leave a clean slate for other tests/sessions.
    saveGlobalConfig(current => ({ ...current, swarmDefaults: undefined }));
    expect(getGlobalConfig().swarmDefaults).toBeUndefined();
  });
});

describe('buildMasterKickoffPrompt — delegation enforcement', () => {
  const prompt = buildMasterKickoffPrompt('Build a water management dashboard');

  test('contains the objective', () => {
    expect(prompt).toContain('Build a water management dashboard');
  });

  test('forbids Write/Edit for the master', () => {
    expect(prompt).toContain('FORBIDDEN');
    expect(prompt).toMatch(/Write|Edit/);
    expect(prompt).toContain('Do NOT create');
  });

  test('requires every deliverable to come from a servant', () => {
    expect(prompt).toMatch(/servant/i);
    expect(prompt).toContain('EVERY deliverable');
  });

  test('instructs parallel dispatch with run_in_background', () => {
    expect(prompt).toContain('run_in_background');
    expect(prompt).toContain('PARALLEL');
  });

  test('ends with DISPATCHED summary line instruction', () => {
    expect(prompt).toContain('DISPATCHED:');
  });

  test('limits decomposition to 2-5 sub-tasks', () => {
    expect(prompt).toMatch(/2.5/);
  });
});

describe('/swarm subcommand routing', () => {
  const routeRoot = path.join('/tmp', 'tau-swarm-route-test');

  beforeEach(() => {
    fs.mkdirSync(routeRoot, { recursive: true });
    SwarmSessionManager.endSession();
  });

  afterEach(() => {
    SwarmSessionManager.endSession();
    if (fs.existsSync(routeRoot)) {
      fs.rmSync(routeRoot, { recursive: true, force: true });
    }
  });

  test('subcommands never start a session', async () => {
    for (const arg of ['help', 'pause', 'steer focus', 'stop', 'status']) {
      const out = await handleSwarmCommand('swarm', arg, routeRoot);
      expect(out).not.toContain('Initialized');
      expect(SwarmSessionManager.getActiveSession()).toBeNull();
    }
  });

  test('exact-word routing does not treat "statusfoo" as status', async () => {
    const out = await handleSwarmCommand('swarm', 'statusfoo', routeRoot);
    // Falls through to the objective path, not the status table.
    expect(out).not.toContain('Swarm Status:');
  });

  test('a running session is not replaced by a new objective', async () => {
    await handleSwarmCommand('swarm', 'first objective', routeRoot);
    const first = SwarmSessionManager.getActiveSession();
    expect(first).not.toBeNull();

    const out = await handleSwarmCommand('swarm', 'second objective', routeRoot);
    expect(out).toContain('already active');
    expect(SwarmSessionManager.getActiveSession()).toBe(first);
    expect(first!.config.projectObjective).toBe('first objective');
  });

  test('/swarm stop releases the session so the clamp and pinning stop applying', async () => {
    await handleSwarmCommand('swarm', 'run the test suite', routeRoot);
    const session = SwarmSessionManager.getActiveSession();
    expect(session).not.toBeNull();
    expect(session!.getActiveSwarmServantPinning()).not.toBeNull();

    const out = await handleSwarmCommand('swarm', 'stop', routeRoot);
    expect(out).toContain('stopped');
    expect(SwarmSessionManager.getActiveSession()).toBeNull();
  });

  test('/swarm stop <anything> stops rather than starting a session', async () => {
    const out = await handleSwarmCommand('swarm', 'stop me', routeRoot);
    expect(out).toContain('No active Swarm session.');
    expect(SwarmSessionManager.getActiveSession()).toBeNull();
  });
});
