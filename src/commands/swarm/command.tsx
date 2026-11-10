import type { Command } from '../../commands.js';
import type { LocalJSXCommandCall } from '../../types/command.js';
import React from 'react';
import { SwarmWizard } from './wizard.js';

/**
 * First words that select a subcommand rather than an objective. Anything here
 * must be handled by `handleSwarmCommand` — an unhandled reserved word would
 * otherwise fall through to "start a session".
 */
const SUBCOMMANDS = new Set([
  'status',
  'pause',
  'hold',
  'resume',
  'release',
  'steer',
  'stop',
  'end',
  'ping',
  'diff',
  'restore',
  'task',
  'wizard',
  'help',
  '?',
  'swarmping',
]);

/**
 * `/swarm` entry.
 *
 * Bare `/swarm` and `/swarm <objective>` open the interactive model-selection
 * wizard (live-pinged healthy models only). Subcommands render the text
 * result from handleSwarmCommand and exit immediately.
 */
export const call: LocalJSXCommandCall = async (onDone, context, args) => {
  const trimmed = (args || '').trim();
  const firstWord = (trimmed.split(/\s+/)[0] ?? '').toLowerCase();
  const rest = trimmed.slice(firstWord.length).trim();

  // Wizard entry paths.
  const isWizard =
    trimmed === '' || firstWord === 'wizard' || (!SUBCOMMANDS.has(firstWord) && !isQuestionish(trimmed));

  if (isWizard) {
    // The wizard finishes by calling startSession(), which replaces the live
    // session and clears its worker roster. Refuse rather than destroy it.
    const { SwarmSessionManager } = await import('../../swarm/swarmManager.js');
    const active = SwarmSessionManager.getActiveSession();
    if (active) {
      onDone(
        [
          '⚠️ **Swarm session already active** — the wizard would replace it.',
          `- Objective: ${active.config.projectObjective}`,
          `- Master: ${active.config.masterModel.label}`,
          `- Servant: ${active.config.defaultServantModel.label}`,
          '',
          'Use `/swarm status` to inspect it, or `/swarm stop` to end it and pick new lanes.',
        ].join('\n'),
        { display: 'system' },
      );
      return null;
    }

    const objective = firstWord === 'wizard' ? rest : trimmed;
    return (
      <SwarmWizard
        onDone={onDone}
        toolUseContext={context}
        initialObjective={objective || undefined}
      />
    );
  }

  // Text subcommands: reuse the shared handler and finish immediately.
  const { handleSwarmCommand } = await import('./index.js');
  const result = await handleSwarmCommand('swarm', trimmed, process.cwd());
  onDone(result, { display: 'system' });
  return null;
};

function isQuestionish(text: string): boolean {
  return /^(what|how|why|who|when|where|which|can you explain|hi|hello|hey|tell me)\b/i.test(text);
}

const swarm = {
  type: 'local-jsx',
  name: 'swarm',
  description: 'Start or inspect the LEAD/EXEC swarm (wizard, status, task, steer, stop, …)',
  immediate: true,
  argumentHint: '[objective | status | task | pause | resume | steer | stop | ping | diff | restore | help]',
  load: () => import('./command.js'),
} satisfies Command;

export default swarm;
