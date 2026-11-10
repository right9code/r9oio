import type { Command } from '../../commands.js';
import type { LocalCommandCall } from '../../types/command.js';

export const call: LocalCommandCall = async (args) => {
  const { SwarmSessionManager } = await import('../../swarm/swarmManager.js');
  const active = SwarmSessionManager.getActiveSession();
  if (!active) {
    return { type: 'text', value: 'No active Swarm session. Start one with /swarm.' };
  }

  const trimmed = (args || '').trim();
  if (!trimmed) {
    return { type: 'text', value: 'Usage: `/steer <guidance>` — e.g. `/steer prioritize auth over db setup`.' };
  }

  active.steer(trimmed);

  const queued = active.coordinationHub.getState().userGuidanceQueue.length;
  const shown = trimmed.length > 200 ? `${trimmed.slice(0, 197)}…` : trimmed;
  const text = [
    `🧭 **Guidance queued for the LEAD**`,
    `> "${shown}"`,
    ``,
    `Logged in \`COORDINATION.md\`; the LEAD picks it up at its next step and adapts EXEC tasks accordingly. (${queued} item${queued === 1 ? '' : 's'} queued)`,
    active.coordinationHub.isPaused() ? `\n*(Swarm is on HOLD — \`/release\` when you want work to resume.)*` : '',
  ].join('\n');

  return { type: 'text', value: text };
};

const steer = {
  type: 'local',
  name: 'steer',
  description: 'Queue mid-flight guidance for the LEAD coordinator',
  immediate: true,
  argumentHint: '<instructions>',
  supportsNonInteractive: true,
  load: () => import('./index.js'),
} satisfies Command;

export default steer;
