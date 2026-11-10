/**
 * Windows `python3` / `pip3` normalization.
 *
 * On Windows, the bare names `python3` and `pip3` frequently resolve to the
 * Microsoft Store "App execution alias" stub (under
 * `%LOCALAPPDATA%\Microsoft\WindowsApps`) when no real `python3` is installed.
 * That stub does NOT run Python — it prints "Python was not found…" and exits
 * non-zero (commonly 9009 or 49). Meanwhile a real interpreter is almost always
 * available under the plain `python` name (or the `py` launcher).
 *
 * The POSIX convention models reach for is `python3`, so commands the model
 * writes fail on Windows for a reason that has nothing to do with the task.
 * This module rewrites a `python3` / `pip3` *command word* to the working
 * interpreter, but ONLY:
 *   - on win32,
 *   - when `python3` does not already run (so we never override a real one —
 *     "if there's no difference, leave it"), and
 *   - when a real replacement actually exists.
 *
 * The rewrite is deliberately token-aware: it only touches `python3` when it is
 * the command being invoked (start of the string or right after a shell
 * separator), never inside a path (`/usr/bin/python3`), a versioned name
 * (`python3.11`), a quoted string, or an argument (`--python3`).
 *
 * Detection is best-effort and memoized; any failure leaves the command
 * untouched.
 */

import { execFileSync } from 'node:child_process'

export type PythonRewrite = {
  /** Replacement command word for `python3`, or null to leave it alone. */
  python3: string | null
  /** Replacement command word for `pip3`, or null to leave it alone. */
  pip3: string | null
}

const NO_REWRITE: PythonRewrite = { python3: null, pip3: null }

/** Returns true iff `cmd args…` runs and exits 0 within the timeout. */
function commandRuns(cmd: string, args: string[]): boolean {
  try {
    execFileSync(cmd, args, {
      stdio: 'ignore',
      windowsHide: true,
      timeout: 4000,
    })
    return true
  } catch {
    return false
  }
}

function detectPythonRewriteUncached(): PythonRewrite {
  if (process.platform !== 'win32') return NO_REWRITE

  const rewrite: PythonRewrite = { python3: null, pip3: null }

  // Only rewrite python3 when it does NOT already work (e.g. it's the Store
  // stub or absent) AND a real replacement exists.
  if (!commandRuns('python3', ['--version'])) {
    if (commandRuns('python', ['--version'])) rewrite.python3 = 'python'
    else if (commandRuns('py', ['-3', '--version'])) rewrite.python3 = 'py -3'
  }

  // Same treatment for pip3 -> pip.
  if (!commandRuns('pip3', ['--version']) && commandRuns('pip', ['--version'])) {
    rewrite.pip3 = 'pip'
  }

  return rewrite
}

let cached: PythonRewrite | undefined

/** Memoized interpreter detection (probes the system once). */
export function detectPythonRewrite(): PythonRewrite {
  if (!cached) cached = detectPythonRewriteUncached()
  return cached
}

/** Test seam: clears the memoized detection result. */
export function __resetPythonRewriteCache(): void {
  cached = undefined
}

/**
 * Rewrite a single command word (`from`) to `to` wherever `from` is the
 * command being invoked. Pure and deterministic — the caller supplies the
 * mapping. `from` is a fixed literal with no regex metacharacters.
 */
function rewriteCommandWord(command: string, from: string, to: string): string {
  // Match `from` at string start or right after a shell separator
  // ( | & ; ( { newline ), allow an optional `.exe`, and require the next
  // char to be whitespace or end-of-string. This protects paths, versioned
  // names (python3.11), arguments, and quoted occurrences.
  const re = new RegExp(`(^|[|&;({\\n])(\\s*)${from}(\\.exe)?(?=\\s|$)`, 'g')
  return command.replace(re, (_m, pre: string, ws: string) => `${pre}${ws}${to}`)
}

/**
 * Apply a mapping to a command string. Pure — no system probing. Exposed for
 * testing and reuse.
 */
export function rewritePythonInterpreter(
  command: string,
  mapping: PythonRewrite,
): string {
  let out = command
  if (mapping.python3) out = rewriteCommandWord(out, 'python3', mapping.python3)
  if (mapping.pip3) out = rewriteCommandWord(out, 'pip3', mapping.pip3)
  return out
}

/**
 * Normalize `python3` / `pip3` invocations for the current platform. No-op on
 * non-Windows and when the command doesn't reference those names. Detection is
 * only triggered (once) when the command actually mentions them.
 */
export function normalizePythonCommand(command: string): string {
  if (process.platform !== 'win32') return command
  // Cheap gate: skip the system probe entirely unless python3/pip3 appears.
  if (!/\bpython3\b|\bpip3\b/.test(command)) return command
  return rewritePythonInterpreter(command, detectPythonRewrite())
}
