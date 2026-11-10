import type { Command } from '../../commands.js'

const safetest = {
  type: 'local-jsx',
  name: 'safetest',
  description: 'Run a file inside a disposable E2B security sandbox',
  argumentHint: '[auto|base|code|python|template-id] @file',
  isSensitive: false,
  load: () => import('./safetest.js'),
} satisfies Command

export default safetest
