/**
 * Co-change coupling checks (pure core over raw git log output).
 *
 * Run via: bun run src/utils/changeCoupling.test.ts
 */

import { computeCoChangeCoupling } from './changeCoupling.js'

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (e: any) {
    failed++
    console.log(`  FAIL ${name}: ${e?.message ?? String(e)}`)
  }
}

function assert(cond: unknown, hint: string): void {
  if (!cond) throw new Error(hint)
}

const DAY = 86_400
const NOW = 1_750_000_000 // fixed anchor; decay uses newest commit, not wall clock

/** Build raw `git log --name-only --format=%x00%ct` output. */
function gitLog(commits: Array<{ daysAgo: number; files: string[] }>): string {
  const parts: string[] = []
  for (const commit of commits) {
    parts.push(`\x00${NOW - commit.daysAgo * DAY}`)
    parts.push(...commit.files, '')
  }
  return parts.join('\n')
}

console.log('computeCoChangeCoupling:')

test('no changed files yields empty result without parsing', () => {
  const result = computeCoChangeCoupling(gitLog([{ daysAgo: 1, files: ['a.ts'] }]), [])
  assert(result.partners.length === 0, 'expected no partners')
  assert(result.commitsScanned === 0, String(result.commitsScanned))
})

test('strong recent coupling is reported with high ratio', () => {
  const commits = []
  // auth.ts and session.ts ship together in 8 of 10 recent commits.
  for (let i = 0; i < 8; i++) {
    commits.push({ daysAgo: i * 3, files: ['src/auth.ts', 'src/session.ts'] })
  }
  commits.push({ daysAgo: 30, files: ['src/auth.ts'] })
  commits.push({ daysAgo: 33, files: ['src/auth.ts', 'README.md'] })
  const result = computeCoChangeCoupling(gitLog(commits), ['src/auth.ts'])
  assert(result.commitsScanned === 10, String(result.commitsScanned))
  const session = result.partners.find(p => p.path === 'src/session.ts')
  assert(session !== undefined, 'session.ts missing from partners')
  assert(session!.partnerOf === 'src/auth.ts', session!.partnerOf)
  assert(session!.ratio >= 0.75 && session!.ratio <= 0.9, String(session!.ratio))
  assert(session!.score >= 2, String(session!.score))
  // README co-changed once — under minScore, excluded.
  assert(!result.partners.some(p => p.path === 'README.md'), 'README should be filtered')
})

test('partners already in the change set are excluded', () => {
  const commits = []
  for (let i = 0; i < 6; i++) {
    commits.push({ daysAgo: i, files: ['a.ts', 'b.ts', 'c.ts'] })
  }
  const result = computeCoChangeCoupling(gitLog(commits), ['a.ts', 'b.ts'])
  assert(!result.partners.some(p => p.path === 'a.ts' || p.path === 'b.ts'),
    'changed files leaked into partners')
  assert(result.partners.some(p => p.path === 'c.ts'), 'c.ts missing')
})

test('ancient co-changes decay below threshold', () => {
  const commits = []
  // 5 co-commits, but all ~3 years old relative to one fresh solo commit.
  commits.push({ daysAgo: 0, files: ['a.ts'] })
  for (let i = 0; i < 5; i++) {
    commits.push({ daysAgo: 1100 + i, files: ['a.ts', 'old-pal.ts'] })
  }
  const result = computeCoChangeCoupling(gitLog(commits), ['a.ts'])
  // weight ≈ 5 * exp(-1100/180) ≈ 0.01 — far below minScore of 2.
  assert(result.partners.length === 0, JSON.stringify(result.partners))
})

test('mass-edit commits contribute no pairs but count toward totals', () => {
  const wide = Array.from({ length: 150 }, (_, i) => `gen/file${i}.ts`)
  const commits = [
    { daysAgo: 0, files: ['a.ts', ...wide] }, // mass edit: no pairs
    { daysAgo: 1, files: ['a.ts', 'friend.ts'] },
    { daysAgo: 2, files: ['a.ts', 'friend.ts'] },
    { daysAgo: 3, files: ['a.ts', 'friend.ts'] },
  ]
  const result = computeCoChangeCoupling(gitLog(commits), ['a.ts'])
  assert(!result.partners.some(p => p.path.startsWith('gen/')), 'mass-edit pair leaked')
  const friend = result.partners.find(p => p.path === 'friend.ts')
  assert(friend !== undefined, 'friend.ts missing')
  // Denominator includes the mass-edit commit: ratio ≈ 3/4, not 3/3.
  assert(friend!.ratio < 0.8, String(friend!.ratio))
})

test('per-file cap applies, sorted by score then path', () => {
  const commits = []
  // Four partners all ride along in 80% of hub commits; p0 gets two extras.
  for (let i = 0; i < 8; i++) {
    commits.push({ daysAgo: i, files: ['hub.ts', 'p0.ts', 'p1.ts', 'p2.ts', 'p3.ts'] })
  }
  commits.push({ daysAgo: 8, files: ['hub.ts', 'p0.ts'] })
  commits.push({ daysAgo: 9, files: ['hub.ts', 'p0.ts'] })
  const result = computeCoChangeCoupling(gitLog(commits), ['hub.ts'])
  assert(result.partners.length === 3, String(result.partners.length)) // maxPerFile
  assert(result.partners[0]!.path === 'p0.ts', result.partners[0]!.path)
  assert(result.partners[1]!.path === 'p1.ts', result.partners[1]!.path) // path tiebreak
  assert(result.partners[0]!.score >= result.partners[1]!.score, 'not sorted')
})

test('windows-style backslash paths in changed files are normalized', () => {
  const commits = []
  for (let i = 0; i < 5; i++) {
    commits.push({ daysAgo: i, files: ['src/auth.ts', 'src/session.ts'] })
  }
  const result = computeCoChangeCoupling(gitLog(commits), ['src\\auth.ts'])
  assert(result.partners.some(p => p.path === 'src/session.ts'), 'normalization failed')
})

test('deterministic across calls', () => {
  const commits = []
  for (let i = 0; i < 20; i++) {
    commits.push({ daysAgo: i, files: ['a.ts', `b${i % 3}.ts`] })
  }
  const log = gitLog(commits)
  const a = JSON.stringify(computeCoChangeCoupling(log, ['a.ts']))
  const b = JSON.stringify(computeCoChangeCoupling(log, ['a.ts']))
  assert(a === b, 'nondeterministic')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
