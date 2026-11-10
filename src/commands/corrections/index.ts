import type { Command } from '../../commands.js'

/**
 * /corrections — deterministic correction mining over this project's session
 * transcripts. Finds commands that failed and were re-run in a fixed form
 * (e.g. `python` failing, `.venv\Scripts\python.exe` working), folds them
 * into rules, and on `apply` writes them into a marker-delimited block in
 * the project CLAUDE.md so the next session runs the right command first.
 * Dry-run by default; no model calls.
 */
const corrections = {
  type: 'local',
  name: 'corrections',
  description:
    'Mine past sessions for command corrections and write them to CLAUDE.md',
  argumentHint: '[apply|clear]',
  isEnabled: () => true,
  supportsNonInteractive: true,
  load: () => import('./corrections.js'),
} satisfies Command

export default corrections
