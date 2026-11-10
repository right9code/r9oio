import type { Command } from '../../commands.js'

const tree = {
  type: 'local-jsx',
  name: 'tree',
  description: 'Navigate the cross-session fork tree for this project',
  argumentHint: '',
  load: () => import('./tree.js'),
} satisfies Command

export default tree
