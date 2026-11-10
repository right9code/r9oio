import type { Command } from '../../commands.js'

const importCmd = {
  type: 'local-jsx',
  name: 'import',
  description:
    'Import a .jsonl session shared by another user and resume into it',
  argumentHint: '<path.jsonl>',
  load: () => import('./import.js'),
} satisfies Command

export default importCmd
