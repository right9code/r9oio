import type { Command } from '../../commands.js';
import type { LocalCommandCall } from '../../types/command.js';

export const call: LocalCommandCall = async (args) => {
  const { handleSwarmCommand } = await import('../swarm/index.js');
  const result = await handleSwarmCommand('swarm', `models ${args || ''}`, process.cwd());
  return { type: 'text', value: result };
};

const swarmmodels = {
  type: 'local',
  name: 'swarmmodels',
  aliases: ['swarm-models'],
  description: 'List and browse all registered models in your gateway/providers catalog',
  immediate: true,
  argumentHint: '[query / search filter]',
  supportsNonInteractive: true,
  load: () => import('./index.js'),
} satisfies Command;

export default swarmmodels;
