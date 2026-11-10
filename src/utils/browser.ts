import { execFileNoThrow } from './execFileNoThrow.js'

/**
 * cmd.exe re-parses the tail after /c, so an unquoted target is split at
 * every unescaped & | < >. An OAuth URL like ...auth?client_id=x&response_type=code
 * would reach the browser truncated at the first "&" (Google rejects it with
 * "Required parameter is missing: response_type"). Caret-escape those
 * metacharacters so cmd passes the full target to `start`.
 *
 * Targets containing whitespace are wrapped in quotes by the spawn argument
 * serializer, which already neutralizes metacharacters — and a caret inside
 * quotes is passed through literally — so those must be left untouched.
 */
export function escapeForCmdStart(target: string): string {
  if (/\s/.test(target)) return target
  return target.replace(/[&|<>^]/g, '^$&')
}

async function openWindowsTarget(target: string): Promise<boolean> {
  const attempts: Array<[string, string[]]> = [
    ['cmd.exe', ['/c', 'start', '', escapeForCmdStart(target)]],
    ['rundll32.exe', ['url.dll,FileProtocolHandler', target]],
    ['explorer.exe', [target]],
  ]

  for (const [file, args] of attempts) {
    const { code } = await execFileNoThrow(file, args, { timeout: 10_000 })
    if (code === 0) return true
  }

  return false
}

function validateUrl(url: string): void {
  let parsedUrl: URL

  try {
    parsedUrl = new URL(url)
  } catch (_error) {
    throw new Error(`Invalid URL format: ${url}`)
  }

  // Validate URL protocol for security
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new Error(
      `Invalid URL protocol: must use http:// or https://, got ${parsedUrl.protocol}`,
    )
  }
}

/**
 * Open a file or folder path using the system's default handler.
 * Uses Windows shell association, `open` on macOS, `xdg-open` on Linux.
 */
export async function openPath(path: string): Promise<boolean> {
  try {
    const platform = process.platform
    if (platform === 'win32') {
      return openWindowsTarget(path)
    }
    const command = platform === 'darwin' ? 'open' : 'xdg-open'
    const { code } = await execFileNoThrow(command, [path])
    return code === 0
  } catch (_) {
    return false
  }
}

export async function openBrowser(url: string): Promise<boolean> {
  try {
    // Parse and validate the URL
    validateUrl(url)

    const browserEnv = process.env.BROWSER
    const platform = process.platform

    if (platform === 'win32') {
      if (browserEnv) {
        // browsers require shell, else they will treat this as a file:/// handle
        const { code } = await execFileNoThrow(browserEnv, [`"${url}"`])
        if (code === 0) return true
      }
      return openWindowsTarget(url)
    } else {
      const command =
        browserEnv || (platform === 'darwin' ? 'open' : 'xdg-open')
      const { code } = await execFileNoThrow(command, [url])
      return code === 0
    }
  } catch (_) {
    return false
  }
}
