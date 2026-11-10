import type { Command } from '../../commands.js'

const mode = {
  type: 'local-jsx',
  name: 'mode',
  aliases: ['power', 'powermode'],
  description:
    'Switch OIO mode: cheap or normal',
  argumentHint: '[cheap|normal]',
  isEnabled: () => true,
  isHidden: false,
  load: () => import('./mode.js'),
} satisfies Command

export default mode
