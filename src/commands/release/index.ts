import type { Command } from '../../commands.js';
import type { LocalCommandCall } from '../../types/command.js';

export const call: LocalCommandCall = async () => {
  const { SwarmSessionManager } = await import('../../swarm/swarmManager.js');
  const active = SwarmSessionManager.getActiveSession();
  if (!active) {
    return { type: 'text', value: 'No active Swarm session to release.' };
  }

  if (!active.coordinationHub.isPaused()) {
    return { type: 'text', value: 'Swarm is already active and running.' };
  }

  active.resume();

  const text = [
    `🟢 **HOLD RELEASED.**`,
    `EXEC workers continue; guidance and status updated in \`COORDINATION.md\`.`,
    `Current guidance and status updated in \`COORDINATION.md\`.`,
  ].join('\n');

  return { type: 'text', value: text };
};

const release = {
  type: 'local',
  name: 'release',
  description: 'Release the hold on Swarm agents and continue tasks',
  immediate: true,
  argumentHint: '',
  supportsNonInteractive: true,
  load: () => import('./index.js'),
} satisfies Command;

export default release;
