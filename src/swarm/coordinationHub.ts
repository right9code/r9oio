import * as fs from 'fs';
import * as path from 'path';
import type { ModelOption } from './modelHealth.js';

export interface SwarmTask {
  id: string;
  subject: string;
  assignedModel?: ModelOption;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  notes?: string;
  filesClaimed?: string[];
}

export interface SwarmState {
  projectObjective: string;
  masterModel: ModelOption;
  defaultServantModel: ModelOption;
  tasks: SwarmTask[];
  qaNotes: Array<{ from: string; question: string; answer?: string; timestamp: string }>;
  isPaused: boolean;
  userGuidanceQueue: string[];
  fileClaims: Record<string, { taskId: string; agentName: string; claimedAt: string }>;
}

export class CoordinationHub {
  private hubFilePath: string;
  private state: SwarmState;

  constructor(projectRoot: string = process.cwd(), initialObjective = 'Swarm Task Execution', masterModel: ModelOption, defaultServant: ModelOption) {
    this.hubFilePath = path.join(projectRoot, 'COORDINATION.md');
    this.state = {
      projectObjective: initialObjective,
      masterModel,
      defaultServantModel: defaultServant,
      tasks: [],
      qaNotes: [],
      isPaused: false,
      userGuidanceQueue: [],
      fileClaims: {},
    };
    this.renderMarkdown();
  }

  /**
   * Attempts to claim a file exclusively for a task and agent.
   * Returns true if successfully claimed, or false if already locked by another task.
   */
  public claimFile(filePath: string, taskId: string, agentName: string): { success: boolean; holder?: { taskId: string; agentName: string } } {
    const resolved = path.resolve(filePath);
    const existing = this.state.fileClaims[resolved];
    if (existing && existing.taskId !== taskId) {
      return { success: false, holder: existing };
    }

    this.state.fileClaims[resolved] = {
      taskId,
      agentName,
      claimedAt: new Date().toISOString(),
    };

    const task = this.state.tasks.find(t => t.id === taskId);
    if (task) {
      task.filesClaimed = task.filesClaimed || [];
      if (!task.filesClaimed.includes(resolved)) {
        task.filesClaimed.push(resolved);
      }
    }

    this.renderMarkdown();
    return { success: true };
  }

  /**
   * Releases all file claims held by a task upon completion or failure.
   */
  public releaseClaimsForTask(taskId: string): string[] {
    const released: string[] = [];
    for (const [fPath, claim] of Object.entries(this.state.fileClaims)) {
      if (claim.taskId === taskId) {
        delete this.state.fileClaims[fPath];
        released.push(fPath);
      }
    }
    const task = this.state.tasks.find(t => t.id === taskId);
    if (task) {
      task.filesClaimed = [];
    }
    this.renderMarkdown();
    return released;
  }

  public addTask(subject: string, model?: ModelOption): SwarmTask {
    const task: SwarmTask = {
      id: `task-${this.state.tasks.length + 1}`,
      subject,
      assignedModel: model || this.state.defaultServantModel,
      status: 'pending',
    };
    this.state.tasks.push(task);
    this.renderMarkdown();
    return task;
  }

  /**
   * Updates task status with strict verification evidence check for 'completed' status.
   */
  public updateTaskStatus(
    taskId: string,
    status: SwarmTask['status'],
    notes?: string,
    verificationEvidence?: { type: 'test' | 'build' | 'file_check' | 'manual'; summary: string }
  ): { success: boolean; error?: string } {
    const t = this.state.tasks.find(x => x.id === taskId);
    if (!t) return { success: false, error: `Task ${taskId} not found` };

    if (status === 'completed' && !verificationEvidence) {
      return {
        success: false,
        error: `Cannot complete task '${t.subject}' without verification evidence (e.g. test exit code, build output, or check).`,
      };
    }

    t.status = status;
    if (notes) {
      t.notes = notes;
    }
    if (verificationEvidence) {
      t.notes = `${t.notes || ''} [Verified via ${verificationEvidence.type}: ${verificationEvidence.summary}]`.trim();
    }
    this.renderMarkdown();
    return { success: true };
  }

  public postQuestion(from: string, question: string, taskId?: string): { allowed: boolean; escalationMessage?: string } {
    // Ping-pong limiter: Check how many unanswered or repeated questions exist for this task/agent
    const previousRounds = this.state.qaNotes.filter(q => q.from === from);
    if (previousRounds.length >= 2 && !previousRounds.slice(-1)[0]?.answer) {
      this.state.isPaused = true;
      const escalation = `⚠️ Excessive Q&A Ping-Pong detected from '${from}' on task '${taskId || 'active'}'. Swarm automatically placed on HOLD to prompt human decision.`;
      this.addGuidance(`[HUMAN ESCALATION REQUIRED]: ${escalation}\nQuestion: "${question}"`);
      return { allowed: false, escalationMessage: escalation };
    }

    this.state.qaNotes.push({
      from,
      question,
      timestamp: new Date().toISOString(),
    });
    this.renderMarkdown();
    return { allowed: true };
  }

  public answerQuestion(index: number, answer: string): void {
    if (this.state.qaNotes[index]) {
      this.state.qaNotes[index].answer = answer;
      this.renderMarkdown();
    }
  }

  public addGuidance(guidance: string): void {
    this.state.userGuidanceQueue.push(guidance);
    this.renderMarkdown();
  }

  public popGuidance(): string | undefined {
    const next = this.state.userGuidanceQueue.shift();
    if (next) this.renderMarkdown();
    return next;
  }

  public setPaused(paused: boolean): void {
    this.state.isPaused = paused;
    this.renderMarkdown();
  }

  public isPaused(): boolean {
    return this.state.isPaused;
  }

  public getState(): SwarmState {
    return this.state;
  }

  public renderMarkdown(): void {
    const s = this.state;
    const lines: string[] = [
      `# Project Swarm Coordination Hub`,
      ``,
      `> **Status**: ${s.isPaused ? '⏸️ PAUSED (Waiting for Human Steering)' : '🟢 ACTIVE'}`,
      `> **Master Model**: \`${s.masterModel.label}\``,
      `> **Default Servant Model**: \`${s.defaultServantModel.label}\``,
      ``,
      `## 🎯 Objective`,
      s.projectObjective,
      ``,
      `## 📋 Task Breakdown & Status`,
      `| ID | Task | Model | Status | Notes |`,
      `| :--- | :--- | :--- | :--- | :--- |`,
    ];

    for (const t of s.tasks) {
      const modelLabel = t.assignedModel ? t.assignedModel.label : 'Default';
      const statusIcon =
        t.status === 'completed' ? '✅ Done' :
        t.status === 'in_progress' ? '⏳ In Progress' :
        t.status === 'failed' ? '❌ Failed' : '🕒 Pending';
      lines.push(`| ${t.id} | ${t.subject} | ${modelLabel} | ${statusIcon} | ${t.notes || ''} |`);
    }

    lines.push(``, `## 💬 Q&A and Inter-Agent Guidance`);
    if (s.qaNotes.length === 0) {
      lines.push(`*No pending questions.*`);
    } else {
      s.qaNotes.forEach((qa, idx) => {
        lines.push(`- **[${qa.timestamp.slice(11, 19)}] ${qa.from}**: ${qa.question}`);
        if (qa.answer) {
          lines.push(`  - 💡 *Answer*: ${qa.answer}`);
        }
      });
    }

    lines.push(``, `## 🔒 Active File Claims (Concurrency Locks)`);
    const claimEntries = Object.entries(s.fileClaims);
    if (claimEntries.length === 0) {
      lines.push(`*No files currently locked.*`);
    } else {
      lines.push(`| File Path | Task ID | Agent | Claimed At |`);
      lines.push(`| :--- | :--- | :--- | :--- |`);
      for (const [f, c] of claimEntries) {
        lines.push(`| \`${f}\` | ${c.taskId} | ${c.agentName} | ${c.claimedAt.slice(11, 19)} |`);
      }
    }

    lines.push(``, `## 🧭 Human Steering Queue`);
    if (s.userGuidanceQueue.length === 0) {
      lines.push(`*No steering commands queued.*`);
    } else {
      s.userGuidanceQueue.forEach((g, idx) => {
        lines.push(`${idx + 1}. ${g}`);
      });
    }

    lines.push(``);
    fs.writeFileSync(this.hubFilePath, lines.join('\n'), 'utf-8');
  }
}
