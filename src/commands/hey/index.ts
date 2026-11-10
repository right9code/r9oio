import type { Command } from '../../commands.js'
import { isHeyModeFeatureOn } from '../../voice/heyModeEnabled.js'

const hey = {
  type: 'local',
  name: 'hey',
  description:
    'Enable hey mode (hold Space to speak, release to submit, /bye disables it)',
  isEnabled: () => isHeyModeFeatureOn(),
  isHidden: false,
  supportsNonInteractive: false,
  load: () => import('./hey.js'),
} satisfies Command

export default hey
