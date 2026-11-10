/**
 * Overlay sandbox service tests — activate, write, read-through, delete,
 * diff, apply, reject round-trips against a scratch project dir.
 *
 * Run: bun run src/services/overlay/overlay.test.ts
 */
import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// Scratch "project" — the overlay only captures paths under its project cwd,
// so envPaths-based root for that cwd is derived inside the module.
const projectCwd = mkdtempSync(join(tmpdir(), 'tau-overlay-test-'))

const {
  activateOverlay,
  deactivateOverlay,
  isOverlayActive,
  getOverlayRoot,
  listOverlayChanges,
  applyOverlay,
  rejectOverlay,
  getOverlayStatus,
} = await import('./overlay.js')
// rawFs bypasses the sandbox impl — reads the REAL tree for assertions.
const rawFs = { readFileSync, existsSync, writeFileSync }

let passed = 0
let failed = 0

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (e: any) {
    failed++
    console.log(`  FAIL  ${name}: ${e?.message ?? String(e)}`)
  }
}

function assert(cond: unknown, hint: string): void {
  if (!cond) throw new Error(hint)
}

// The FS impl to write through — grabs the CURRENT (sandboxed) impl.
const { getFsImplementation } = await import('../../utils/fsOperations.js')

async function main(): Promise<void> {
  console.log('overlay sandbox service:')

  // Baseline real files
  rawFs.writeFileSync(join(projectCwd, 'existing.txt'), 'original\n')
  rawFs.writeFileSync(join(projectCwd, 'doomed.txt'), 'delete me\n')
  mkdirSync(join(projectCwd, 'nested'))
  rawFs.writeFileSync(join(projectCwd, 'nested', 'keep.txt'), 'keep\n')

  await test('activate: sandbox on, overlay root created', () => {
    activateOverlay(projectCwd)
    assert(isOverlayActive(), 'active flag')
    const root = getOverlayRoot()
    assert(root !== null && existsSync(root), 'overlay root exists')
  })

  await test('write goes to overlay, real tree untouched', () => {
    const fs = getFsImplementation()
    fs.writeFileSync(join(projectCwd, 'new.txt'), 'hello\n')
    assert(!rawFs.existsSync(join(projectCwd, 'new.txt')), 'real tree untouched')
    const root = getOverlayRoot()!
    assert(rawFs.existsSync(join(root, 'new.txt')), 'overlay copy exists')
  })

  await test('edit of real file lands in overlay only, real byte-identical', () => {
    const fs = getFsImplementation()
    fs.writeFileSync(join(projectCwd, 'existing.txt'), 'edited\n')
    assert(
      rawFs.readFileSync(join(projectCwd, 'existing.txt'), 'utf8') === 'original\n',
      'real file unchanged',
    )
    const root = getOverlayRoot()!
    assert(
      rawFs.readFileSync(join(root, 'existing.txt'), 'utf8') === 'edited\n',
      'overlay copy has edit',
    )
  })

  await test('read-through: overlay wins for touched, real for untouched', () => {
    const fs = getFsImplementation()
    assert(
      fs.readFileSync(join(projectCwd, 'existing.txt'), { encoding: 'utf8' }) === 'edited\n',
      'touched file reads overlay content',
    )
    assert(
      fs.readFileSync(join(projectCwd, 'nested', 'keep.txt'), { encoding: 'utf8' }) === 'keep\n',
      'untouched file reads real content',
    )
  })

  await test('new file in nested dir: overlay only, real tree clean', () => {
    const fs = getFsImplementation()
    fs.writeFileSync(join(projectCwd, 'a', 'b', 'c.txt'), 'deep\n')
    const root = getOverlayRoot()!
    assert(rawFs.existsSync(join(root, 'a', 'b', 'c.txt')), 'overlay nested copy')
    assert(!rawFs.existsSync(join(projectCwd, 'a')), 'real tree has no a/')
  })

  await test('delete writes tombstone; file reads as gone; real file still on disk', () => {
    const fs = getFsImplementation()
    fs.unlinkSync(join(projectCwd, 'doomed.txt'))
    assert(!fs.existsSync(join(projectCwd, 'doomed.txt')), 'sandbox says gone')
    let threw = false
    try {
      fs.readFileSync(join(projectCwd, 'doomed.txt'), { encoding: 'utf8' })
    } catch (e: any) {
      threw = true
      assert(e.code === 'ENOENT', `ENOENT expected, got ${e.code}`)
    }
    assert(threw, 'read throws')
    assert(rawFs.existsSync(join(projectCwd, 'doomed.txt')), 'real file still on disk')
  })

  await test('listOverlayChanges: statuses added/modified/deleted', async () => {
    const changes = await listOverlayChanges()
    const byFile = new Map(changes.map(c => [c.file, c]))
    assert(byFile.get('new.txt')?.status === 'added', 'new.txt added')
    assert(byFile.get('existing.txt')?.status === 'modified', 'existing.txt modified')
    assert(byFile.get('doomed.txt')?.status === 'deleted', 'doomed.txt deleted')
    assert(byFile.get('a/b/c.txt')?.status === 'added', 'a/b/c.txt added')
  })

  await test('diff patch content has +lines for edits', async () => {
    const changes = await listOverlayChanges()
    const existing = changes.find(c => c.file === 'existing.txt')
    assert(existing, 'existing.txt in changes')
    assert(existing!.patch.includes('+edited'), `patch has +edited: ${existing!.patch}`)
  })

  await test('status reports pending count', async () => {
    const status = await getOverlayStatus()
    assert(status.active, 'active')
    assert(status.pending === 4, `expected 4 pending, got ${status.pending}`)
  })

  // ---- apply round-trip on a FRESH overlay ----
  await test('reject: overlay cleared, real tree never touched', async () => {
    const rootBefore = getOverlayRoot()
    await rejectOverlay()
    assert(!isOverlayActive(), 'off after reject')
    if (rootBefore) assert(!rawFs.existsSync(rootBefore), 'overlay dir gone')
    assert(
      rawFs.readFileSync(join(projectCwd, 'existing.txt'), 'utf8') === 'original\n',
      'existing.txt still original',
    )
    assert(!rawFs.existsSync(join(projectCwd, 'new.txt')), 'new.txt never landed')
    assert(rawFs.existsSync(join(projectCwd, 'doomed.txt')), 'doomed.txt still there')
  })

  await test('apply: lands overlay content, processes tombstones, deactivates', async () => {
    activateOverlay(projectCwd)
    const fs = getFsImplementation()
    fs.writeFileSync(join(projectCwd, 'existing.txt'), 'applied\n')
    fs.writeFileSync(join(projectCwd, 'brand-new.txt'), 'brand\n')
    fs.unlinkSync(join(projectCwd, 'doomed.txt'))
    const result = await applyOverlay()
    assert(result.applied === 2, `applied 2, got ${result.applied}`)
    assert(result.deleted === 1, `deleted 1, got ${result.deleted}`)
    assert(!isOverlayActive(), 'deactivated after apply')
    assert(
      rawFs.readFileSync(join(projectCwd, 'existing.txt'), 'utf8') === 'applied\n',
      'existing.txt has applied content',
    )
    assert(
      rawFs.readFileSync(join(projectCwd, 'brand-new.txt'), 'utf8') === 'brand\n',
      'brand-new.txt landed',
    )
    assert(!rawFs.existsSync(join(projectCwd, 'doomed.txt')), 'doomed.txt removed from disk')
  })

  await test('nested/keep.txt survived everything untouched', () => {
    assert(
      rawFs.readFileSync(join(projectCwd, 'nested', 'keep.txt'), 'utf8') === 'keep\n',
      'keep.txt intact',
    )
  })

  await test('off: normal writes resume', () => {
    assert(!isOverlayActive(), 'off')
    const fs = getFsImplementation()
    fs.writeFileSync(join(projectCwd, 'direct.txt'), 'direct\n')
    assert(
      rawFs.readFileSync(join(projectCwd, 'direct.txt'), 'utf8') === 'direct\n',
      'write lands directly on real tree',
    )
  })

  console.log(
    `\n${passed} passed, ${failed} failed ${failed === 0 ? '— ALL OK' : '— FAILURES'}`,
  )
  if (failed > 0) process.exitCode = 1
}

await main()
