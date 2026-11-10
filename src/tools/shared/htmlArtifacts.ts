import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { isAbsolute, join, resolve } from 'path'

import { getCwd } from '../../utils/cwd.js'

export function htmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function slugifyArtifactTitle(value: string | undefined, fallback: string): string {
  return (value || fallback)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72) || fallback
}

export function resolveArtifactDir(
  outputDir: string | undefined,
  defaultSubdir: string,
): string {
  if (!outputDir?.trim()) return join(getCwd(), '.oio', defaultSubdir)
  return isAbsolute(outputDir) ? outputDir : resolve(getCwd(), outputDir)
}

export function uniqueArtifactSlug(
  dir: string,
  baseSlug: string,
  extensions: readonly string[],
  overwrite: boolean | undefined,
): string {
  if (overwrite === true) return baseSlug

  let slug = baseSlug
  let index = 2
  while (extensions.some(ext => existsSync(join(dir, `${slug}${ext}`)))) {
    slug = `${baseSlug}-${index}`
    index += 1
  }
  return slug
}

export function ensureArtifactDir(dir: string): void {
  mkdirSync(dir, { recursive: true })
}

export function writeArtifactFile(path: string, content: string): void {
  writeFileSync(path, content, 'utf8')
}
