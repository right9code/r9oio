/**
 * Co-change coupling: which files historically get committed together.
 *
 * One `git log --name-only` walk (O(1) subprocesses) accumulates
 * decay-weighted co-occurrence between the CURRENTLY CHANGED files and the
 * rest of the repo, so RepoContextScout can say "sessionMiddleware.ts ships
 * with auth.ts in 80% of its commits and hasn't been touched". Co-change is
 * a temporal hint (files committed together), not a verified code
 * dependency — it is surfaced with its weight and recency, never invented.
 *
 * Algorithm follows the repowise co-change indexer: exponential temporal
 * decay (recent commits count more), mass-edit commits skipped (rename
 * sweeps / codemods produce O(N²) pairs and no signal), minimum decayed
 * weight before a pair is reported. Decay is anchored to the repo's most
 * recent scanned commit — NOT wall-clock time — so the result is a pure
 * function of git history (deterministic across reruns on the same repo
 * state, like every other tool output in the pipeline).
 */

import { existsSync } from 'fs'
import { join } from 'path'

import { execFileNoThrowWithCwd } from './execFileNoThrow.js'

export type CoChangePartner = {
  /** Repo-relative partner path (forward slashes). */
  path: string
  /** The currently-changed file this partner historically ships with. */
  partnerOf: string
  /** Decay-weighted co-change weight (higher = stronger, recency-biased). */
  score: number
  /** score / changed file's own decayed commit weight — "in X% of the
   * commits that touch partnerOf, this file changed too" (0..1). */
  ratio: number
  /** ISO date (UTC) of the most recent shared commit, when known. */
  lastCoChange?: string
}

export type CoChangeCoupling = {
  /** Top partners NOT part of the current change, strongest first. */
  partners: CoChangePartner[]
  commitsScanned: number
  warnings: string[]
}

export type CoChangeOptions = {
  /** Commits to walk. Wider than per-file history so sparse couplings clear
   * the weight threshold (repowise uses 2000; 1000 keeps the CLI snappy). */
  commitLimit?: number
  /** Decay time constant in days (exp(-age/tau); ~125-day half-life). */
  decayTauDays?: number
  /** Skip pair generation for commits touching more files than this. */
  maxFilesPerCommit?: number
  /** Minimum decayed weight for a pair to be reported. */
  minScore?: number
  /** Minimum ratio (pair weight / changed file weight) to be reported. */
  minRatio?: number
  /** Cap on partners reported per changed file. */
  maxPerFile?: number
  /** Global cap on reported partners. */
  maxTotal?: number
}

const DEFAULTS: Required<CoChangeOptions> = {
  commitLimit: 1000,
  decayTauDays: 180,
  maxFilesPerCommit: 100,
  minScore: 2,
  minRatio: 0.3,
  maxPerFile: 3,
  maxTotal: 10,
}

const GIT_TIMEOUT_MS = 5_000
const GIT_MAX_BUFFER = 5_000_000

function normalizeGitPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^"|"$/g, '')
}

function isoDateUtc(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10)
}

/**
 * Pure accumulation over raw `git log --name-only --no-merges --format=%x00%ct`
 * output. Exported for direct unit testing; production callers use
 * collectCoChangeCoupling which adds the git subprocess and existence filter.
 */
export function computeCoChangeCoupling(
  rawLog: string,
  changedFiles: readonly string[],
  options?: CoChangeOptions,
): CoChangeCoupling {
  const opts = { ...DEFAULTS, ...options }
  const changedSet = new Set(changedFiles.map(normalizeGitPath))
  if (changedSet.size === 0) {
    return { partners: [], commitsScanned: 0, warnings: [] }
  }

  // First pass: parse commits (timestamp + file set), find the decay anchor.
  type Commit = { ts: number; files: string[] }
  const commits: Commit[] = []
  let current: string[] = []
  let currentTs = 0
  let sawBoundary = false
  const flush = () => {
    if (sawBoundary) commits.push({ ts: currentTs, files: current })
  }
  for (const rawLine of rawLog.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (line.startsWith('\x00')) {
      flush()
      sawBoundary = true
      current = []
      const parsed = parseInt(line.slice(1).trim(), 10)
      currentTs = Number.isFinite(parsed) ? parsed : 0
    } else if (line.trim()) {
      current.push(normalizeGitPath(line.trim()))
    }
  }
  flush()

  if (commits.length === 0) {
    return { partners: [], commitsScanned: 0, warnings: [] }
  }

  // Anchor decay to the newest scanned commit for determinism.
  let anchorTs = 0
  for (const commit of commits) {
    if (commit.ts > anchorTs) anchorTs = commit.ts
  }

  // pairScore keyed changed → partner → weight; changedTotals tracks each
  // changed file's own decayed commit weight (ratio denominator).
  const pairScore = new Map<string, Map<string, number>>()
  const pairLast = new Map<string, Map<string, number>>()
  const changedTotals = new Map<string, number>()

  for (const commit of commits) {
    const files = [...new Set(commit.files)]
    if (files.length === 0) continue
    const present = files.filter(f => changedSet.has(f))
    if (present.length === 0) continue

    const ageDays = Math.max((anchorTs - commit.ts) / 86_400, 0)
    const weight = Math.exp(-ageDays / opts.decayTauDays)

    for (const c of present) {
      changedTotals.set(c, (changedTotals.get(c) ?? 0) + weight)
    }
    // Mass-edit commits still count toward totals (the file DID change),
    // but contribute no pairs — O(N²) noise, not coupling signal.
    if (files.length > opts.maxFilesPerCommit) continue

    for (const c of present) {
      let scores = pairScore.get(c)
      let lasts = pairLast.get(c)
      if (!scores) {
        scores = new Map()
        pairScore.set(c, scores)
      }
      if (!lasts) {
        lasts = new Map()
        pairLast.set(c, lasts)
      }
      for (const other of files) {
        if (other === c) continue
        scores.set(other, (scores.get(other) ?? 0) + weight)
        if (commit.ts > (lasts.get(other) ?? 0)) lasts.set(other, commit.ts)
      }
    }
  }

  // Rank per changed file, drop partners already in the change set.
  const partners: CoChangePartner[] = []
  const sortedChanged = [...pairScore.keys()].sort()
  for (const changed of sortedChanged) {
    const total = changedTotals.get(changed) ?? 0
    if (total <= 0) continue
    const candidates: CoChangePartner[] = []
    for (const [partner, score] of pairScore.get(changed)!) {
      if (changedSet.has(partner)) continue
      if (score < opts.minScore) continue
      const ratio = score / total
      if (ratio < opts.minRatio) continue
      const lastTs = pairLast.get(changed)?.get(partner) ?? 0
      candidates.push({
        path: partner,
        partnerOf: changed,
        score: Math.round(score * 100) / 100,
        ratio: Math.min(Math.round(ratio * 100) / 100, 1),
        ...(lastTs > 0 && { lastCoChange: isoDateUtc(lastTs) }),
      })
    }
    candidates.sort(
      (a, b) => b.score - a.score || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
    )
    partners.push(...candidates.slice(0, opts.maxPerFile))
  }

  partners.sort(
    (a, b) => b.score - a.score || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
  )

  return {
    partners: partners.slice(0, opts.maxTotal),
    commitsScanned: commits.length,
    warnings: [],
  }
}

/**
 * Run the git walk for `root` and compute coupling for `changedFiles`
 * (repo-relative paths). Best-effort: any git failure returns an empty
 * result with a warning rather than throwing. Partners that no longer exist
 * on disk (renamed/deleted paths from old history) are filtered out.
 */
export async function collectCoChangeCoupling(
  root: string,
  changedFiles: readonly string[],
  options?: CoChangeOptions,
): Promise<CoChangeCoupling> {
  const opts = { ...DEFAULTS, ...options }
  if (changedFiles.length === 0) {
    return { partners: [], commitsScanned: 0, warnings: [] }
  }

  const result = await execFileNoThrowWithCwd(
    'git',
    [
      'log',
      `-${opts.commitLimit}`,
      '--name-only',
      '--no-merges',
      '--format=%x00%ct',
    ],
    {
      cwd: root,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
      preserveOutputOnError: true,
    },
  )
  if (result.code !== 0 || !result.stdout) {
    return {
      partners: [],
      commitsScanned: 0,
      warnings: [`git log for co-change coupling failed (exit ${result.code}).`],
    }
  }

  const coupling = computeCoChangeCoupling(result.stdout, changedFiles, options)
  return {
    ...coupling,
    partners: coupling.partners.filter(partner =>
      existsSync(join(root, partner.path)),
    ),
  }
}
