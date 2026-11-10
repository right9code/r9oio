/**
 * PTY service — runs commands inside a pseudoterminal so the agent can drive
 * TUIs, REPLs, password prompts, and other shells that need a real TTY.
 *
 * node-pty is an optional native dependency; this module reports
 * `isPtyAvailable() === false` when it isn't installed. Callers (and the
 * tool's `isEnabled()`) must check before invoking.
 */
import { logError } from '../../utils/log.js'

// node-pty is an optionalDependency: the native build can fail or the user
// can skip it entirely. The type is `any` (not typeof import('node-pty')) so
// typecheckers don't fail when @types/node-pty isn't present.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type NodePtyModule = any

let cached: NodePtyModule | null | undefined = undefined

function loadNodePty(): NodePtyModule | null {
  if (cached !== undefined) return cached
  try {
    // Dynamic require so the build never depends on node-pty being present.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    cached = require('node-pty') as NodePtyModule
  } catch {
    cached = null
  }
  return cached
}

export function isPtyAvailable(): boolean {
  return loadNodePty() !== null
}

export type PtyRunOptions = {
  command: string
  cwd?: string
  env?: Record<string, string>
  cols?: number
  rows?: number
  timeoutMs?: number
  /** Bytes; output beyond this is silently dropped (kept for the model). */
  maxOutputBytes?: number
  /** Optional abort signal — killing the pty when fired. */
  signal?: AbortSignal
  /** Optional callback for streaming output (e.g., progress UI). */
  onData?: (chunk: string) => void
}

export type PtyRunResult = {
  ok: boolean
  output: string
  exitCode: number | null
  signal: number | string | null
  timedOut: boolean
  aborted: boolean
  truncated: boolean
  durationMs: number
  message?: string
}

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024 // 1 MiB

function defaultShell(): { file: string; args: string[] } {
  if (process.platform === 'win32') {
    const ps = process.env.PSModulePath
      ? 'powershell.exe'
      : (process.env.ComSpec ?? 'cmd.exe')
    return { file: ps, args: [] }
  }
  const shell = process.env.SHELL ?? '/bin/sh'
  return { file: shell, args: [] }
}

/**
 * Spawn a shell inside a PTY, send a command, and collect output until
 * exit, timeout, or abort. Suitable for interactive commands that wouldn't
 * run correctly in plain child_process.spawn (no TTY).
 */
export async function ptyRun(opts: PtyRunOptions): Promise<PtyRunResult> {
  const pty = loadNodePty()
  if (!pty) {
    return {
      ok: false,
      output: '',
      exitCode: null,
      signal: null,
      timedOut: false,
      aborted: false,
      truncated: false,
      durationMs: 0,
      message: 'node-pty not installed (optional dependency missing)',
    }
  }

  const timeoutMs = Math.max(100, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const maxBytes = Math.max(1024, opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES)
  const { file, args } = defaultShell()

  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') env[k] = v
  }
  if (opts.env) {
    for (const [k, v] of Object.entries(opts.env)) {
      env[k] = v
    }
  }
  // Force a known TERM so TUIs render meaningfully and ANSI codes are honored.
  env.TERM = opts.env?.TERM ?? process.env.TERM ?? 'xterm-256color'

  const start = Date.now()
  let output = ''
  let bytes = 0
  let truncated = false
  let timedOut = false
  let aborted = false
  let exitCode: number | null = null
  let signal: number | string | null = null

  const child = pty.spawn(file, args, {
    name: 'xterm-256color',
    cols: opts.cols ?? 120,
    rows: opts.rows ?? 30,
    cwd: opts.cwd ?? process.cwd(),
    env,
  })

  const appendChunk = (chunk: string): void => {
    if (truncated) return
    const remaining = maxBytes - bytes
    if (chunk.length > remaining) {
      output += chunk.slice(0, remaining)
      bytes += remaining
      truncated = true
    } else {
      output += chunk
      bytes += chunk.length
    }
    try {
      opts.onData?.(chunk)
    } catch (e) {
      logError(`pty onData callback failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const onAbort = (): void => {
    aborted = true
    try {
      child.kill()
    } catch {
      /* already gone */
    }
  }
  if (opts.signal) {
    if (opts.signal.aborted) {
      onAbort()
    } else {
      opts.signal.addEventListener('abort', onAbort, { once: true })
    }
  }

  return await new Promise<PtyRunResult>(resolve => {
    let timer: NodeJS.Timeout | null = setTimeout(() => {
      timer = null
      timedOut = true
      try {
        child.kill()
      } catch {
        /* already gone */
      }
    }, timeoutMs)

    const cleanup = (): void => {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      if (opts.signal) {
        opts.signal.removeEventListener('abort', onAbort)
      }
    }

    child.onData(appendChunk)
    child.onExit(
      (event: { exitCode: number; signal?: number | string }): void => {
        const code = event.exitCode
        const sig = event.signal
        exitCode = code
        signal = sig ?? null
        cleanup()
        resolve({
          ok: code === 0 && !timedOut && !aborted,
          output,
          exitCode,
          signal,
          timedOut,
          aborted,
          truncated,
          durationMs: Date.now() - start,
        })
      },
    )

    // Send the command. On Windows shells \r\n is required; on POSIX \n
    // works and \r is harmless. Then send "exit" so the shell terminates
    // cleanly after running the command.
    const trailer = process.platform === 'win32' ? '\r\n' : '\n'
    child.write(opts.command + trailer + 'exit' + trailer)
  })
}
