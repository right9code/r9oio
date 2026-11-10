/**
 * Correction mining: learn "ran X, failed, then Y worked" from session
 * transcripts, deterministically (no LLM).
 *
 * The classic case: `python script.py` fails with "'python' is not
 * recognized", the agent re-runs `.venv\Scripts\python.exe script.py` and it
 * works — every session re-derives this. Mining walks the project's past
 * transcripts, pairs each failed shell command with the next similar
 * successful one in the same session, folds the pairs into a handful of
 * rules, and (via the /corrections command) writes them into a marker-
 * delimited block in the project CLAUDE.md so the NEXT session runs the
 * right command first.
 *
 * Precision beats recall throughout: an unpaired failure teaches nothing
 * bad, but a wrong rule actively misleads every future session. Pairing
 * requires structural similarity (executable swap with same arguments,
 * prefix added, or same executable with adjusted arguments) — a failure
 * followed by an unrelated successful command never pairs.
 *
 * This module is a leaf (node builtins only): the pure mining core is
 * directly unit-testable, and the transcript scanner takes the project
 * transcript directory as an argument.
 */

import { createReadStream } from 'fs'
import { readdir, stat } from 'fs/promises'
import { join } from 'path'
import { createInterface } from 'readline'

// Tool names, hardcoded rather than imported so this stays a leaf module.
// Must match BASH_TOOL_NAME / POWERSHELL_TOOL_NAME.
const SHELL_TOOL_NAMES: Record<string, 'bash' | 'powershell'> = {
  Bash: 'bash',
  PowerShell: 'powershell',
}

export type CommandEvent = {
  sessionId: string
  /** Monotonic order within the session (result arrival order). */
  seq: number
  shell: 'bash' | 'powershell'
  command: string
  failed: boolean
  /** Short failure signature for rule rendering. */
  errorExcerpt?: string
  /** ISO timestamp of the result line, when present. */
  timestamp?: string
}

export type CorrectionRule = {
  kind: 'executable-swap' | 'prefix-added' | 'args-adjusted'
  failedForm: string
  fixedForm: string
  shell: 'bash' | 'powershell'
  occurrences: number
  /** YYYY-MM-DD of the most recent observation. */
  lastSeen?: string
  errorHint?: string
}

// --- Failure detection -------------------------------------------------------

const NONZERO_EXIT = /(?:^|\n)Exit code:? (?!0\b)\d+/
const ERROR_SIGNATURE =
  /(is not recognized|command not found|No such file or directory|ENOENT|EACCES|Permission denied|cannot find|Unknown command|unrecognized (?:option|argument)|SyntaxError|ParserError|CommandNotFoundException|Missing script|not a git repository)/i

export function isFailureResult(
  isError: boolean | undefined,
  content: string,
): boolean {
  if (isError === true) return true
  return NONZERO_EXIT.test(content)
}

export function extractErrorExcerpt(content: string): string | undefined {
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed && ERROR_SIGNATURE.test(trimmed)) {
      return trimmed.length > 120 ? `${trimmed.slice(0, 117)}…` : trimmed
    }
  }
  const first = content.split(/\r?\n/).find(l => l.trim())
  if (!first) return undefined
  const trimmed = first.trim()
  return trimmed.length > 120 ? `${trimmed.slice(0, 117)}…` : trimmed
}

// --- Command similarity ------------------------------------------------------

function tokenize(command: string): string[] {
  return command
    .trim()
    .split(/\s+/)
    .map(token => token.replace(/^["']|["']$/g, ''))
    .filter(Boolean)
}

function jaccard(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 && b.length === 0) return 1
  const setA = new Set(a)
  const setB = new Set(b)
  let shared = 0
  for (const token of setA) if (setB.has(token)) shared++
  const unionSize = setA.size + setB.size - shared
  return unionSize === 0 ? 1 : shared / unionSize
}

function normalizeForCompare(command: string): string {
  return command.trim().replace(/\s+/g, ' ')
}

type PairClassification = {
  kind: CorrectionRule['kind']
  /** Aggregation key: rules with the same key merge across sessions. */
  key: string
  failedForm: string
  fixedForm: string
}

/**
 * Classify a (failed, fixed) command pair, or return null when the two are
 * not structurally similar enough to be a correction.
 */
export function classifyCorrectionPair(
  failedCommand: string,
  fixedCommand: string,
  shell: 'bash' | 'powershell',
): PairClassification | null {
  const failedNorm = normalizeForCompare(failedCommand)
  const fixedNorm = normalizeForCompare(fixedCommand)
  if (!failedNorm || !fixedNorm || failedNorm === fixedNorm) return null

  const failedTokens = tokenize(failedNorm)
  const fixedTokens = tokenize(fixedNorm)
  if (failedTokens.length === 0 || fixedTokens.length === 0) return null

  const failedExe = failedTokens[0]!
  const fixedExe = fixedTokens[0]!

  // Prefix added: the fix runs the SAME command after extra setup, e.g.
  // `cd app && npm test` or `source .venv/bin/activate && python run.py`.
  if (fixedNorm.endsWith(failedNorm) && fixedNorm.length > failedNorm.length) {
    const prefix = fixedNorm.slice(0, fixedNorm.length - failedNorm.length).trim()
    // Require a real connective so `Xnpm test` noise can't slip in.
    if (prefix.endsWith('&&') || prefix.endsWith(';') || prefix.endsWith('|')) {
      return {
        kind: 'prefix-added',
        key: `prefix:${shell}:${prefix}::${failedExe}`,
        failedForm: failedNorm,
        fixedForm: fixedNorm,
      }
    }
  }

  // Executable swap: different first token, essentially the same arguments —
  // `python x.py` → `.venv\Scripts\python.exe x.py`, `npm test` → `pnpm test`.
  if (failedExe !== fixedExe) {
    const failedRest = failedTokens.slice(1)
    const fixedRest = fixedTokens.slice(1)
    const restSimilar =
      (failedRest.length === 0 && fixedRest.length === 0) ||
      jaccard(failedRest, fixedRest) >= 0.6
    if (restSimilar) {
      // The swap generalizes across arguments — key on the executables only.
      return {
        kind: 'executable-swap',
        key: `swap:${shell}:${failedExe}→${fixedExe}`,
        failedForm: failedExe,
        fixedForm: fixedExe,
      }
    }
    return null
  }

  // Same executable, adjusted arguments (added flag, fixed path/quoting).
  if (jaccard(failedTokens, fixedTokens) >= 0.5) {
    return {
      kind: 'args-adjusted',
      key: `args:${shell}:${failedNorm}→${fixedNorm}`,
      failedForm: failedNorm,
      fixedForm: fixedNorm,
    }
  }

  return null
}

// --- Mining core -------------------------------------------------------------

export type MineOptions = {
  /** How many subsequent commands may separate failure from fix. */
  lookahead?: number
  /** Minimum observations for the noisier args-adjusted rules. */
  minArgsAdjustedOccurrences?: number
  /** Cap on returned rules. */
  maxRules?: number
}

const MINE_DEFAULTS: Required<MineOptions> = {
  lookahead: 5,
  minArgsAdjustedOccurrences: 2,
  maxRules: 10,
}

function isoDate(timestamp: string | undefined): string | undefined {
  if (!timestamp) return undefined
  const date = timestamp.slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : undefined
}

/**
 * Fold command events (ordered per session) into correction rules.
 * Pure and deterministic: same events, same rules.
 */
export function mineCorrections(
  events: readonly CommandEvent[],
  options?: MineOptions,
): CorrectionRule[] {
  const opts = { ...MINE_DEFAULTS, ...options }

  // Group by session, preserving order.
  const sessions = new Map<string, CommandEvent[]>()
  for (const event of events) {
    let list = sessions.get(event.sessionId)
    if (!list) {
      list = []
      sessions.set(event.sessionId, list)
    }
    list.push(event)
  }

  type Aggregate = CorrectionRule & { key: string }
  const aggregates = new Map<string, Aggregate>()

  for (const list of sessions.values()) {
    const ordered = [...list].sort((a, b) => a.seq - b.seq)
    for (let i = 0; i < ordered.length; i++) {
      const failure = ordered[i]!
      if (!failure.failed) continue
      // Identical re-run that later succeeded = flaky command, not a
      // correction; also stop pairing at the next failure of the SAME
      // command (the model was still thrashing).
      for (
        let j = i + 1;
        j < ordered.length && j <= i + opts.lookahead;
        j++
      ) {
        const candidate = ordered[j]!
        if (candidate.shell !== failure.shell) continue
        if (
          normalizeForCompare(candidate.command) ===
          normalizeForCompare(failure.command)
        ) {
          // Exact re-run: success → flaky (no rule); failure → keep looking
          // (the eventual fix still corrects THIS command).
          if (!candidate.failed) break
          continue
        }
        if (candidate.failed) continue
        const classified = classifyCorrectionPair(
          failure.command,
          candidate.command,
          failure.shell,
        )
        if (!classified) continue

        const date = isoDate(candidate.timestamp ?? failure.timestamp)
        const existing = aggregates.get(classified.key)
        if (existing) {
          existing.occurrences++
          if (date && (!existing.lastSeen || date > existing.lastSeen)) {
            existing.lastSeen = date
            if (failure.errorExcerpt) existing.errorHint = failure.errorExcerpt
          }
        } else {
          aggregates.set(classified.key, {
            key: classified.key,
            kind: classified.kind,
            failedForm: classified.failedForm,
            fixedForm: classified.fixedForm,
            shell: failure.shell,
            occurrences: 1,
            ...(date && { lastSeen: date }),
            ...(failure.errorExcerpt && { errorHint: failure.errorExcerpt }),
          })
        }
        break // first fix wins for this failure
      }
    }
  }

  return [...aggregates.values()]
    .filter(
      rule =>
        rule.kind !== 'args-adjusted' ||
        rule.occurrences >= opts.minArgsAdjustedOccurrences,
    )
    .sort(
      (a, b) =>
        b.occurrences - a.occurrences ||
        (b.lastSeen ?? '').localeCompare(a.lastSeen ?? '') ||
        a.key.localeCompare(b.key),
    )
    .slice(0, opts.maxRules)
    .map(({ key: _key, ...rule }) => rule)
}

// --- Transcript scanning (IO) -------------------------------------------------

export type ScanOptions = {
  /** Most-recent session files to scan. */
  maxSessions?: number
  /** Per-file line cap (defensive against giant transcripts). */
  maxLinesPerFile?: number
}

const SCAN_DEFAULTS: Required<ScanOptions> = {
  maxSessions: 40,
  maxLinesPerFile: 50_000,
}

const SESSION_FILE = /^[0-9a-f-]{36}\.jsonl$/i

type PendingUse = { command: string; shell: 'bash' | 'powershell' }

/**
 * Extract ordered CommandEvents from one transcript's JSONL lines.
 * Exported for testing; scanTranscriptsForCorrections feeds it files.
 */
export function extractCommandEvents(
  lines: Iterable<string>,
  sessionId: string,
): CommandEvent[] {
  const pending = new Map<string, PendingUse>()
  const events: CommandEvent[] = []
  let seq = 0

  for (const line of lines) {
    if (!line.trim()) continue
    let entry: any
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (entry?.isSidechain === true) continue
    const content = entry?.message?.content
    if (!Array.isArray(content)) continue

    if (entry.type === 'assistant') {
      for (const block of content) {
        if (block?.type !== 'tool_use' || typeof block.id !== 'string') continue
        const shell = SHELL_TOOL_NAMES[block.name as string]
        const command = block.input?.command
        if (!shell || typeof command !== 'string' || !command.trim()) continue
        pending.set(block.id, { command, shell })
      }
    } else if (entry.type === 'user') {
      for (const block of content) {
        if (block?.type !== 'tool_result') continue
        const use = pending.get(block.tool_use_id as string)
        if (!use) continue
        pending.delete(block.tool_use_id as string)
        const resultText =
          typeof block.content === 'string'
            ? block.content
            : Array.isArray(block.content)
              ? block.content
                  .map((b: any) => (b?.type === 'text' ? b.text : ''))
                  .join('\n')
              : ''
        const failed = isFailureResult(block.is_error, resultText)
        events.push({
          sessionId,
          seq: seq++,
          shell: use.shell,
          command: use.command,
          failed,
          ...(failed && {
            errorExcerpt: extractErrorExcerpt(resultText),
          }),
          ...(typeof entry.timestamp === 'string' && {
            timestamp: entry.timestamp,
          }),
        })
      }
    }
  }
  return events
}

async function readFileEvents(
  filePath: string,
  sessionId: string,
  maxLines: number,
): Promise<CommandEvent[]> {
  const lines: string[] = []
  const rl = createInterface({
    input: createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  })
  try {
    for await (const line of rl) {
      lines.push(line)
      if (lines.length >= maxLines) break
    }
  } finally {
    rl.close()
  }
  return extractCommandEvents(lines, sessionId)
}

/**
 * Scan the newest session transcripts under `projectTranscriptDir`
 * (the per-project directory holding `<sessionId>.jsonl` files) and mine
 * correction rules. Unreadable files are skipped silently.
 */
export async function scanTranscriptsForCorrections(
  projectTranscriptDir: string,
  scanOptions?: ScanOptions,
  mineOptions?: MineOptions,
): Promise<{ rules: CorrectionRule[]; sessionsScanned: number }> {
  const opts = { ...SCAN_DEFAULTS, ...scanOptions }

  let names: string[]
  try {
    names = await readdir(projectTranscriptDir)
  } catch {
    return { rules: [], sessionsScanned: 0 }
  }

  const candidates: Array<{ path: string; sessionId: string; mtimeMs: number }> =
    []
  for (const name of names) {
    if (!SESSION_FILE.test(name)) continue
    const path = join(projectTranscriptDir, name)
    try {
      const info = await stat(path)
      if (info.isFile()) {
        candidates.push({
          path,
          sessionId: name.slice(0, -'.jsonl'.length),
          mtimeMs: info.mtimeMs,
        })
      }
    } catch {
      // Skip unreadable entries.
    }
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)
  const selected = candidates.slice(0, opts.maxSessions)

  const events: CommandEvent[] = []
  for (const candidate of selected) {
    try {
      events.push(
        ...(await readFileEvents(
          candidate.path,
          candidate.sessionId,
          opts.maxLinesPerFile,
        )),
      )
    } catch {
      // Skip files that fail mid-read.
    }
  }

  return {
    rules: mineCorrections(events, mineOptions),
    sessionsScanned: selected.length,
  }
}

// --- CLAUDE.md block rendering -------------------------------------------------

export const CORRECTIONS_BEGIN = '<!-- tau:learned-corrections:start -->'
export const CORRECTIONS_END = '<!-- tau:learned-corrections:end -->'

function renderRule(rule: CorrectionRule): string {
  const seen =
    rule.occurrences > 1
      ? `seen ${rule.occurrences}x${rule.lastSeen ? `, last ${rule.lastSeen}` : ''}`
      : rule.lastSeen
        ? `seen ${rule.lastSeen}`
        : ''
  const hint = rule.errorHint ? ` — failed with "${rule.errorHint}"` : ''
  const meta = seen ? ` (${seen})` : ''
  switch (rule.kind) {
    case 'executable-swap':
      return `- Use \`${rule.fixedForm}\` instead of \`${rule.failedForm}\`${hint}${meta}.`
    case 'prefix-added':
      return `- Run \`${rule.fixedForm}\` — the bare \`${rule.failedForm}\` fails here${hint}${meta}.`
    case 'args-adjusted':
      return `- Use \`${rule.fixedForm}\` instead of \`${rule.failedForm}\`${hint}${meta}.`
  }
}

/** Render the full marker-delimited CLAUDE.md block for these rules. */
export function renderCorrectionsBlock(rules: readonly CorrectionRule[]): string {
  return [
    CORRECTIONS_BEGIN,
    '<!-- Auto-generated by /corrections from this project\'s session transcripts. Do not edit inside this block; re-run `/corrections apply` to refresh or `/corrections clear` to remove. -->',
    '## Command corrections (learned)',
    ...rules.map(renderRule),
    CORRECTIONS_END,
  ].join('\n')
}

/**
 * Idempotently upsert (or, with `block === null`, remove) the corrections
 * block in a CLAUDE.md body. Content outside the markers is untouched.
 */
export function upsertCorrectionsBlock(
  existing: string,
  block: string | null,
): string {
  const beginIdx = existing.indexOf(CORRECTIONS_BEGIN)
  const endIdx = existing.indexOf(CORRECTIONS_END)

  if (beginIdx !== -1 && endIdx !== -1 && endIdx > beginIdx) {
    const before = existing.slice(0, beginIdx)
    const after = existing.slice(endIdx + CORRECTIONS_END.length)
    if (block === null) {
      const joined = `${before.replace(/\n+$/, '\n')}${after.replace(/^\n+/, '\n')}`
      const trimmed = joined.replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '')
      return trimmed.trim() === '' ? '' : trimmed
    }
    return `${before}${block}${after}`
  }

  if (block === null) return existing
  if (existing.trim() === '') return `${block}\n`
  return `${existing.replace(/\n+$/, '')}\n\n${block}\n`
}
