import type { Command } from '../../commands.js'

const clone = {
  type: 'local-jsx',
  name: 'clone',
  description:
    'Duplicate the current conversation as a backup, then switch into the copy',
  argumentHint: '[suffix]',
  load: () => import('./clone.js'),
} satisfies Command

export default clone
