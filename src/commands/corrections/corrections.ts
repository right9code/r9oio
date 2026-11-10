import { readFile, writeFile } from 'fs/promises'

import { getOriginalCwd } from '../../bootstrap/state.js'
import type { LocalCommandResult } from '../../types/command.js'
import { getMemoryPath } from '../../utils/config.js'
import {
  CORRECTIONS_BEGIN,
  renderCorrectionsBlock,
  scanTranscriptsForCorrections,
  upsertCorrectionsBlock,
} from '../../utils/correctionMining.js'
import { getProjectDir } from '../../utils/sessionStorage.js'

const HELP = `/corrections — mine past sessions for command corrections (ran X, failed, Y worked).

Usage:
  /corrections          scan transcripts and preview the rules (writes nothing)
  /corrections apply    write/refresh the rules block in this project's CLAUDE.md
  /corrections clear    remove the rules block from CLAUDE.md

The block is marker-delimited and idempotent: re-running apply replaces it in
place, and everything outside the markers is never touched. Mining is fully
deterministic — no model calls.`

async function readFileOrEmpty(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return ''
  }
}

export async function call(args: string): Promise<LocalCommandResult> {
  const action = (args ?? '').trim().toLowerCase()
  if (action && action !== 'apply' && action !== 'clear') {
    return { type: 'text' as const, value: HELP }
  }

  const claudeMdPath = getMemoryPath('Project')

  if (action === 'clear') {
    const existing = await readFileOrEmpty(claudeMdPath)
    if (!existing.includes(CORRECTIONS_BEGIN)) {
      return {
        type: 'text' as const,
        value: `No corrections block found in ${claudeMdPath} — nothing to clear.`,
      }
    }
    await writeFile(claudeMdPath, upsertCorrectionsBlock(existing, null), 'utf8')
    return {
      type: 'text' as const,
      value: `Removed the learned-corrections block from ${claudeMdPath}.`,
    }
  }

  const projectTranscriptDir = getProjectDir(getOriginalCwd())
  const { rules, sessionsScanned } = await scanTranscriptsForCorrections(
    projectTranscriptDir,
  )

  if (rules.length === 0) {
    return {
      type: 'text' as const,
      value: `Scanned ${sessionsScanned} session transcript(s): no failed→fixed command patterns found. Nothing to write.`,
    }
  }

  const block = renderCorrectionsBlock(rules)

  if (action === 'apply') {
    const existing = await readFileOrEmpty(claudeMdPath)
    await writeFile(claudeMdPath, upsertCorrectionsBlock(existing, block), 'utf8')
    return {
      type: 'text' as const,
      value:
        `Wrote ${rules.length} correction rule(s) (from ${sessionsScanned} sessions) into ${claudeMdPath}:\n\n` +
        `${block}\n\n` +
        `They load with CLAUDE.md from the next session on. Re-run \`/corrections apply\` anytime to refresh, or \`/corrections clear\` to remove.`,
    }
  }

  return {
    type: 'text' as const,
    value:
      `Found ${rules.length} correction rule(s) across ${sessionsScanned} session transcript(s) — preview (nothing written):\n\n` +
      `${block}\n\n` +
      `Run \`/corrections apply\` to write this block into ${claudeMdPath}.`,
  }
}
