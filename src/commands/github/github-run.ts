import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.js'
import type { Command } from '../../commands.js'
import { ALLOWED_TOOLS, HELP_TEXT, SUBCOMMANDS } from './prompts.js'

const command = {
  type: 'prompt',
  name: 'github-run',
  description: 'Internal engine for the /github wizard',
  argumentHint: '<issue|pr|wrap|changelog|triage|release> [args]',
  contentLength: 0,
  progressMessage: 'managing GitHub',
  source: 'builtin',
  allowedTools: ALLOWED_TOOLS,
  // Hidden from typeahead — users see /github (the wizard). Power users
  // who know about /github-run can still type it directly.
  isHidden: true,
  // The model should not invoke this on its own; only the wizard or the
  // user does.
  disableModelInvocation: true,
  async getPromptForCommand(args: string): Promise<ContentBlockParam[]> {
    const trimmed = (args ?? '').trim()
    if (!trimmed) {
      return [{ type: 'text', text: HELP_TEXT }]
    }
    const [sub, ...rest] = trimmed.split(/\s+/)
    const subKey = sub.toLowerCase()
    const builder = SUBCOMMANDS[subKey]
    if (!builder) {
      return [
        {
          type: 'text',
          text: `Unknown /github subcommand: \`${sub}\`.\n\n${HELP_TEXT}`,
        },
      ]
    }
    return [{ type: 'text', text: builder(rest.join(' ')) }]
  },
} satisfies Command

export default command
