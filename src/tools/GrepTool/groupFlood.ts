/**
 * Grouped fallback for content-mode grep floods.
 *
 * When a content-mode search matches more lines than the display limit, the
 * flat "first N lines" slice shows a few files exhaustively and drops the
 * rest — the model sees 250 lines from the first two files instead of the
 * shape of the result. This module folds the FULL match set into a per-file
 * digest (count + line anchors, sorted by count) so the model sees that a
 * symbol appears 40 times across 6 files and can drill into exactly the
 * file it needs.
 *
 * Determinism contract: output is a pure function of the input lines. Tool
 * results are mapped to API blocks once at execution time and frozen into
 * the conversation, so any per-call nondeterminism here would not break the
 * prompt cache — but determinism keeps retries, tests, and transcript replay
 * byte-stable, matching the rest of the tool-output pipeline. No dates, no
 * locale-dependent formatting, no Map iteration order dependence beyond
 * explicit sorts.
 */

/** Grouping only kicks in when the flood is real: this many times over the
 * display limit OR spanning at least this many files. A 260-line result at
 * limit 250 is better served by the plain slice + pagination note. */
const FLOOD_FACTOR = 1.5
const FLOOD_MIN_FILES = 4

/** Display caps keeping the digest itself small and stable. */
const MAX_FILES_LISTED = 40
const MAX_ANCHORS_PER_FILE = 12

/** If more than this fraction of lines fail to parse as `path:num:...`,
 * grouping would misreport counts — fall back to the flat slice. */
const MAX_UNPARSED_FRACTION = 0.1

type FileGroup = {
  /** Path exactly as it appears in the ripgrep output line. */
  rawPath: string
  /** 1-based line numbers of matches, in output order. */
  anchors: number[]
}

export type GroupedGrepSummary = {
  /** Model-facing digest replacing the flat match lines. */
  content: string
  /** Total matching lines across all files. */
  numLines: number
  /** Number of distinct files with at least one match. */
  numFiles: number
}

/**
 * Parse one ripgrep content-mode line (`path:lineNumber:content`) into its
 * path and line number. Windows drive letters survive the lazy path match
 * because `C:` is followed by a separator, not digits — the first `:<digits>:`
 * in a line is the line-number separator unless the path itself contains one
 * (not possible on Windows, rare enough on POSIX to be covered by the
 * unparsed-fraction fallback).
 */
export function parseGrepContentLine(
  line: string,
): { path: string; lineNumber: number } | null {
  const match = /^(.+?):(\d+):/.exec(line)
  if (!match) return null
  return { path: match[1]!, lineNumber: parseInt(match[2]!, 10) }
}

function formatAnchors(anchors: number[]): string {
  const shown = anchors.slice(0, MAX_ANCHORS_PER_FILE)
  const suffix = anchors.length > shown.length ? ', …' : ''
  return shown.join(', ') + suffix
}

/**
 * Build the grouped digest for a flooded content-mode grep, or return null
 * when the flat slice should be kept (not flooded enough, context lines in
 * play upstream, or output too irregular to group truthfully).
 *
 * @param lines      Full (unsliced) ripgrep content-mode output lines.
 * @param limit      The effective display limit that was exceeded.
 * @param relativize Path display transform (injected so this module stays a
 *                   leaf: no cwd state import, directly unit-testable).
 */
export function buildGroupedGrepSummary(
  lines: readonly string[],
  limit: number,
  relativize: (path: string) => string,
): GroupedGrepSummary | null {
  if (lines.length <= limit) return null

  const groups = new Map<string, FileGroup>()
  let parsed = 0
  for (const line of lines) {
    const entry = parseGrepContentLine(line)
    if (!entry) continue
    parsed++
    const group = groups.get(entry.path)
    if (group) {
      group.anchors.push(entry.lineNumber)
    } else {
      groups.set(entry.path, { rawPath: entry.path, anchors: [entry.lineNumber] })
    }
  }

  const unparsed = lines.length - parsed
  if (parsed === 0 || unparsed / lines.length > MAX_UNPARSED_FRACTION) {
    return null
  }

  // Only group when the flood is real; a marginal overflow reads better flat.
  if (
    lines.length < limit * FLOOD_FACTOR &&
    groups.size < FLOOD_MIN_FILES
  ) {
    return null
  }

  // Count desc, then path asc — fully deterministic ordering.
  const sorted = [...groups.values()].sort(
    (a, b) =>
      b.anchors.length - a.anchors.length ||
      (a.rawPath < b.rawPath ? -1 : a.rawPath > b.rawPath ? 1 : 0),
  )

  const listed = sorted.slice(0, MAX_FILES_LISTED)
  const omitted = sorted.slice(MAX_FILES_LISTED)
  const omittedLines = omitted.reduce((sum, g) => sum + g.anchors.length, 0)

  const out: string[] = [
    `${parsed} matching lines across ${groups.size} files exceed the ${limit}-line display limit, so matches are grouped by file instead of shown in full.`,
    '',
  ]
  for (const group of listed) {
    const count = group.anchors.length
    out.push(
      `${relativize(group.rawPath)} — ${count} ${count === 1 ? 'match' : 'matches'} (lines ${formatAnchors(group.anchors)})`,
    )
  }
  if (omitted.length > 0) {
    out.push(`… and ${omitted.length} more files (${omittedLines} matches)`)
  }
  out.push(
    '',
    'To see match content, narrow the search (path, glob, or a more specific pattern), or re-run with a higher head_limit / offset pagination.',
  )

  return {
    content: out.join('\n'),
    numLines: parsed,
    numFiles: groups.size,
  }
}
