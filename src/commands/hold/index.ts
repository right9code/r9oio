import type { Command } from '../../commands.js';
import type { LocalCommandCall } from '../../types/command.js';

export const call: LocalCommandCall = async (args) => {
  const { SwarmSessionManager } = await import('../../swarm/swarmManager.js');
  const active = SwarmSessionManager.getActiveSession();
  if (!active) {
    return { type: 'text', value: 'No active Swarm session to hold. Start one with /swarm.' };
  }

  active.pause(args || 'Put on hold by user via /hold');

  const text = [
    `⏸️ **Swarm is on HOLD.** New EXEC dispatches are blocked (running workers finish on their own).`,
    ``,
    `**LEAD asks:** *"What would you like to do next?"*`,
    ``,
    `Choose an action:`,
    `1. 🧭 **Steer Master**: Type \`/steer <your new instruction or course correction>\``,
    `2. 🔄 **Swap Model**: Type \`/swarm models\` to test & switch models`,
    `3. ⏪ **Revert Edits**: Type \`/swarm restore\` to rollback modified files from the backup vault`,
    `4. 🟢 **Proceed**: Type \`/release\` when you are ready for agents to continue`,
  ].join('\n');

  return { type: 'text', value: text };
};

const hold = {
  type: 'local',
  name: 'hold',
  description: 'Put the swarm on hold and ask what to do next',
  immediate: true,
  argumentHint: '[reason]',
  supportsNonInteractive: true,
  load: () => import('./index.js'),
} satisfies Command;

export default hold;
