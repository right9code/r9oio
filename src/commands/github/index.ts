import type { Command } from '../../commands.js'

const github = {
  type: 'local-jsx',
  name: 'github',
  description:
    'GitHub repo manager — issue, pr, wrap, changelog, triage, release',
  argumentHint: '[issue|pr|wrap|changelog|triage|release]',
  load: () => import('./github.js'),
} satisfies Command

export default github
