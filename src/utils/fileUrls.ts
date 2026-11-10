import { fileURLToPath, pathToFileURL } from 'url'
import { expandPath } from './path.js'
import { getCwd } from './cwd.js'

export interface LocalFileUrlTarget {
  path: string
  url: string
}

const FILE_SCHEME_RE = /^file:/i
const FILE_SCHEME_WITH_AUTHORITY_RE = /^file:\/\//i
const WINDOWS_DRIVE_RE = /^[a-zA-Z]:[\\/]/

function stripFileUrlSuffix(value: string): string {
  const queryIndex = value.indexOf('?')
  const hashIndex = value.indexOf('#')
  const indexes = [queryIndex, hashIndex].filter(index => index >= 0)
  const end = indexes.length > 0 ? Math.min(...indexes) : value.length
  return value.slice(0, end)
}

function decodeFileUrlPath(value: string): string {
  const stripped = stripFileUrlSuffix(value).replace(/\\/g, '/')
  try {
    return decodeURIComponent(stripped)
  } catch {
    return stripped
  }
}

function fromPath(path: string): LocalFileUrlTarget {
  return {
    path,
    url: pathToFileURL(path).href,
  }
}

export function pathToLocalFileUrl(path: string): string {
  return pathToFileURL(path).href
}

function explicitRelativeFileUrlPath(input: string): string | null {
  if (!FILE_SCHEME_RE.test(input)) return null

  const payload = input.slice(input.indexOf(':') + 1)
  if (payload.startsWith('//')) {
    const authorityAndPath = payload.slice(2)
    if (
      authorityAndPath.startsWith('.') ||
      authorityAndPath.startsWith('..')
    ) {
      return decodeFileUrlPath(authorityAndPath)
    }
    return null
  }

  if (!payload || payload.startsWith('/') || WINDOWS_DRIVE_RE.test(payload)) {
    return null
  }

  return decodeFileUrlPath(payload)
}

function authorityRelativeFileUrlPath(input: string): string | null {
  if (!FILE_SCHEME_WITH_AUTHORITY_RE.test(input)) return null

  const authorityAndPath = input.slice(input.indexOf('//') + 2)
  if (!authorityAndPath || authorityAndPath.startsWith('/')) return null
  if (/^localhost(?:[/?#:]|$)/i.test(authorityAndPath)) return null
  if (WINDOWS_DRIVE_RE.test(authorityAndPath)) return null

  return decodeFileUrlPath(authorityAndPath)
}

/**
 * Resolve a local file URL to a native filesystem path and canonical file URL.
 *
 * The WHATWG URL parser treats `file://.tau/artifacts/x.html` as a URL whose
 * host is `.tau`. In practice, agents and humans often mean a workspace-relative
 * local artifact path. Resolve those relative-looking forms against Tau's cwd
 * while preserving standard absolute file URLs and Windows UNC file URLs.
 */
export function resolveLocalFileUrlTarget(
  input: string,
  cwd: string = getCwd(),
): LocalFileUrlTarget {
  const trimmed = input.trim()
  const explicitRelative = explicitRelativeFileUrlPath(trimmed)
  if (explicitRelative !== null) {
    return fromPath(expandPath(explicitRelative, cwd))
  }

  const parsed = new URL(trimmed)
  if (parsed.protocol !== 'file:') {
    throw new Error(`Expected file URL, got ${parsed.protocol}`)
  }

  try {
    return fromPath(fileURLToPath(parsed))
  } catch (error) {
    const authorityRelative = authorityRelativeFileUrlPath(trimmed)
    if (authorityRelative !== null) {
      return fromPath(expandPath(authorityRelative, cwd))
    }

    if (parsed.host === '' && parsed.pathname) {
      return fromPath(expandPath(decodeFileUrlPath(parsed.pathname), cwd))
    }

    throw error
  }
}

/**
 * Resolve any local-file target spelling to a native path and canonical file URL.
 *
 * Accepts absolute paths, cwd-relative paths, canonical file URLs, and the
 * common malformed/relative file URL forms that agents produce for artifacts.
 */
export function resolveLocalFileTarget(
  input: string,
  cwd: string = getCwd(),
): LocalFileUrlTarget {
  const trimmed = input.trim()
  if (FILE_SCHEME_RE.test(trimmed)) {
    return resolveLocalFileUrlTarget(trimmed, cwd)
  }
  return fromPath(expandPath(trimmed, cwd))
}
