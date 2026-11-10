/**
 * Smoke test for the built CLI's overlay command wiring (non-interactive).
 * Simulates: /overlay on → agent Write tool writes file → /overlay diff →
 * /overlay apply → verify real tree, using the same service the CLI loads.
 */
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { execFileSync } from 'child_process'

const projectCwd = mkdtempSync(join(tmpdir(), 'tau-overlay-smoke-'))
writeFileSync(join(projectCwd, 'README.md'), '# scratch\n')
execFileSync('git', ['init', '-q'], { cwd: projectCwd })
execFileSync('git', ['add', '-A'], { cwd: projectCwd })
execFileSync('git', ['commit', '-qm', 'init'], { cwd: projectCwd })

// The real CLI activates on the SESSION cwd — replicate that here so the
// overlay captures the scratch project, not wherever bun was launched from.
process.chdir(projectCwd)

// Load the command implementation the same way the CLI lazy-loads it.
const { call } = await import('../src/commands/overlay/overlay.js')
const overlay = await import('../src/services/overlay/overlay.js')
const { getFsImplementation } = await import('../src/utils/fsOperations.js')

let failures = 0
const check = (cond: unknown, hint: string) => {
  console.log(`  ${cond ? 'ok ' : 'FAIL'}  ${hint}`)
  if (!cond) failures++
}

// 1. status before on
let r = await call('status', {} as never)
check((r as { type: string; value?: string }).value?.includes('off') === true, 'status shows off')

// 2. /overlay on
r = await call('on', {} as never)
check((r as any).value.includes('ON'), 'on: sandbox ON')

// 3. Agent-style write through writeTextContent (the real Write tool path)
const { writeTextContent } = await import('../src/utils/file.js')
writeTextContent(join(projectCwd, 'poem.txt'), 'roses are red\n', 'utf-8', 'LF')
writeTextContent(join(projectCwd, 'README.md'), '# scratch\n\nedited by agent\n', 'utf-8', 'LF')

// 4. Real tree untouched, git status clean
const gitStatus = execFileSync('git', ['status', '--porcelain'], { cwd: projectCwd, encoding: 'utf8' })
check(gitStatus.trim() === '', `real tree git status clean (got: ${JSON.stringify(gitStatus)})`)
check(!existsSync(join(projectCwd, 'poem.txt')), 'poem.txt not in real tree')
check(readFileSync(join(projectCwd, 'README.md'), 'utf8') === '# scratch\n', 'README.md unchanged')

// 5. Tools read through the overlay
const fs = getFsImplementation()
check(
  fs.readFileSync(join(projectCwd, 'README.md'), { encoding: 'utf8' }).includes('edited by agent'),
  'read-through sees overlay content',
)

// 6. /overlay status shows 2 pending
r = await call('status', {} as never)
check((r as any).value.includes('2 pending'), `status: 2 pending (got: ${(r as any).value})`)

// 7. /overlay diff shows both
r = await call('diff', {} as never)
const diffText = (r as any).value as string
check(diffText.includes('poem.txt') && diffText.includes('README.md'), 'diff lists both files')
check(diffText.includes('+roses are red'), 'diff has +roses line')

// 8. /overlay apply lands everything
r = await call('apply', {} as never)
check(
  readFileSync(join(projectCwd, 'poem.txt'), 'utf8') === 'roses are red\n',
  'poem.txt landed in real tree',
)
check(
  readFileSync(join(projectCwd, 'README.md'), 'utf8').includes('edited by agent'),
  'README.md edit landed',
)
check(!overlay.isOverlayActive(), 'sandbox off after apply')

// 9. Second round: write then REJECT
r = await call('on', {} as never)
writeTextContent(join(projectCwd, 'junk.txt'), 'throwaway\n', 'utf-8', 'LF')
r = await call('reject', {} as never)
check(!existsSync(join(projectCwd, 'junk.txt')), 'junk.txt never landed after reject')
r = await call('status', {} as never)
check((r as any).value.includes('off'), 'status off after reject')

console.log(failures === 0 ? '\nSMOKE: ALL OK' : `\nSMOKE: ${failures} FAILURES`)
process.exitCode = failures === 0 ? 0 : 1
