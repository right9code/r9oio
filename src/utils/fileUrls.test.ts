/**
 * Local file URL normalization regression tests.
 *
 * Run: bun run src/utils/fileUrls.test.ts
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, normalize } from 'path'
import { pathToFileURL } from 'url'
import { resolveLocalFileTarget, resolveLocalFileUrlTarget } from './fileUrls.js'

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (error: any) {
    failed++
    console.log(`  FAIL ${name}: ${error?.message ?? String(error)}`)
  }
}

function assertEqual(actual: unknown, expected: unknown, hint: string): void {
  if (actual !== expected) {
    throw new Error(
      `${hint}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`,
    )
  }
}

function main(): void {
  console.log('file URL normalization:')

  const base = mkdtempSync(join(tmpdir(), 'tau-file-url-'))
  const artifactDir = join(base, '.oio', 'artifacts')
  mkdirSync(artifactDir, { recursive: true })
  const summaryPath = join(artifactDir, 'tool-test-summary.html')
  const spacedPath = join(artifactDir, 'space name.html')
  writeFileSync(summaryPath, '<!doctype html><title>Summary</title>', 'utf8')
  writeFileSync(spacedPath, '<!doctype html><title>Space</title>', 'utf8')

  try {
    test('resolves file://.oio artifacts from the workspace cwd', () => {
      const target = resolveLocalFileUrlTarget(
        'file://.oio/artifacts/tool-test-summary.html',
        base,
      )
      assertEqual(target.path, normalize(summaryPath), 'relative file:// host must resolve from cwd')
      assertEqual(target.url, pathToFileURL(summaryPath).href, 'URL must be canonical file:/// form')
    })

    test('decodes relative file URL paths before resolving', () => {
      const target = resolveLocalFileUrlTarget(
        'file://./.oio/artifacts/space%20name.html?cache=1#section',
        base,
      )
      assertEqual(target.path, normalize(spacedPath), 'encoded file URL path must decode')
      assertEqual(target.url, pathToFileURL(spacedPath).href, 'query and hash do not identify the file path')
    })

    test('supports file: relative shorthand', () => {
      const target = resolveLocalFileUrlTarget(
        'file:.oio/artifacts/tool-test-summary.html',
        base,
      )
      assertEqual(target.path, normalize(summaryPath), 'file:relative path must resolve from cwd')
    })

    test('resolves plain relative artifact paths from the workspace cwd', () => {
      const target = resolveLocalFileTarget(
        '.oio/artifacts/tool-test-summary.html',
        base,
      )
      assertEqual(target.path, normalize(summaryPath), 'relative artifact path must resolve from cwd')
      assertEqual(target.url, pathToFileURL(summaryPath).href, 'relative artifact path must get a canonical file URL')
    })

    test('resolves plain absolute paths without requiring file:// wrapping', () => {
      const target = resolveLocalFileTarget(spacedPath, base)
      assertEqual(target.path, normalize(spacedPath), 'absolute path must remain absolute')
      assertEqual(target.url, pathToFileURL(spacedPath).href, 'absolute path with spaces must be URL-encoded')
    })

    test('keeps standard absolute file URLs canonical', () => {
      const absoluteUrl = pathToFileURL(summaryPath).href
      const target = resolveLocalFileUrlTarget(`${absoluteUrl}?cache=1#section`, base)
      assertEqual(target.path, normalize(summaryPath), 'absolute file URL must map to the same file')
      assertEqual(target.url, absoluteUrl, 'absolute file URL output must remain canonical')
    })

    if (process.platform === 'win32') {
      test('preserves non-relative file:// hosts as Windows UNC paths', () => {
        const target = resolveLocalFileUrlTarget('file://server/share/report.html', base)
        assertEqual(target.path, '\\\\server\\share\\report.html', 'UNC host must not become cwd-relative')
      })
    }
  } finally {
    rmSync(base, { recursive: true, force: true })
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main()
