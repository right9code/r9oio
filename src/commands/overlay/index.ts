import type { Command } from '../../commands.js'
import { isOverlayActive } from '../../services/overlay/overlay.js'

const overlay = {
  description: 'Manage the file-edit overlay sandbox (/overlay on|off|status|diff|apply|reject)',
  name: 'overlay',
  argumentHint: 'on|off|status|diff|apply|reject',
  type: 'local',
  supportsNonInteractive: false,
  load: () => import('./overlay.js'),
} satisfies Command

export default overlay
