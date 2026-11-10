import { realpathSync } from 'fs'
import { tmpdir } from 'os'
import { isAbsolute, join, relative, resolve } from 'path'
import { sanitizePath } from './sessionStoragePortable.js'

function isInsidePath(child: string, parent: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function pathParts(path: string): string[] {
  return path.split(/[\\/]+/).filter(Boolean)
}

function getClaudeTempDirNameForSavedOutputPaths(): string {
  return process.platform === 'win32'
    ? 'claude'
    : `claude-${process.getuid?.() ?? 0}`
}

function getClaudeTempDirForSavedOutputPaths(): string {
  const baseTmpDir =
    process.env.CLAUDE_CODE_TMPDIR ||
    (process.platform === 'win32' ? tmpdir() : '/tmp')
  try {
    return join(
      realpathSync(baseTmpDir),
      getClaudeTempDirNameForSavedOutputPaths(),
    )
  } catch {
    return join(baseTmpDir, getClaudeTempDirNameForSavedOutputPaths())
  }
}

export function getProjectTempDirForTauOutputPaths(
  originalCwd: string,
): string {
  return join(getClaudeTempDirForSavedOutputPaths(), sanitizePath(originalCwd))
}

export function isAllowedTauManagedTaskOutputPath(
  path: string,
  originalCwd: string,
): boolean {
  const resolvedPath = resolve(path)
  const projectTempDir = resolve(getProjectTempDirForTauOutputPaths(originalCwd))
  if (!isInsidePath(resolvedPath, projectTempDir)) return false

  const parts = pathParts(relative(projectTempDir, resolvedPath))
  return (
    parts.length === 3 &&
    parts[0]!.length > 0 &&
    parts[1] === 'tasks' &&
    parts[2]!.endsWith('.output')
  )
}
