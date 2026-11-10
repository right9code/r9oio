/**
 * Bash Retry Guard — prevents infinite retry loops.
 *
 * Non-frontier models (especially free-tier OpenRouter models) frequently
 * retry failing commands in a loop — sometimes 30+ times with the same or
 * near-identical command — without ever diagnosing the root cause.
 *
 * This module tracks recent Bash failures for diagnostics. Failure history
 * never blocks execution; workdir normalization and target discovery handle
 * recoverable mistakes before the command runs.
 *
 * The guard auto-resets when:
 *   - A diagnostic command runs (ls, cat, which, find, echo, etc.)
 *   - A completely different command runs successfully
 *   - The failure cache ages out (5 minutes TTL)
 */

const MAX_TRACKED_FAILURES = 20
const FAILURE_TTL_MS = 5 * 60_000 // 5 minutes
const MAX_RETRIES_BEFORE_BLOCK = 2 // Allow 1 retry, block on 2nd

// Secondary "intent thrashing" detector: when the same set of executables
// fails N times in a short window with DIFFERENT exact commands, the model
// is varying cosmetic details (paths, flags, ports) instead of diagnosing.
// The per-signature counter above doesn't catch this — each variant is a
// new signature. These thresholds catch the broader pattern.
const MAX_INTENT_FAILURES = 3
const INTENT_TTL_MS = 60_000 // 1 minute

interface FailureEntry {
  /** Normalized command signature for matching */
  signature: string
  /** Original command text */
  command: string
  /** Number of consecutive attempts */
  attempts: number
  /** Timestamp of last attempt */
  lastAttempt: number
  /** Exit code from last failure */
  exitCode: number
  /** Truncated output from last failure (for context) */
  lastOutput: string
}

/** Commands that are considered "diagnostic" and reset the retry guard */
const DIAGNOSTIC_COMMANDS = new Set([
  'ls', 'dir', 'll',
  'cat', 'head', 'tail', 'less', 'more', 'type',
  'which', 'where', 'whereis', 'command',
  'file', 'stat',
  'find', 'locate',
  'echo', 'printf',
  'pwd', 'cd',
  'env', 'printenv', 'set',
  'npm', 'node', 'python', 'python3', 'pip', 'pip3',  // with diagnostic subcommands
  'git', // with diagnostic subcommands
  'test', '[',
  'readlink', 'realpath', 'basename', 'dirname',
  'uname', 'hostname',
  'df', 'du',
  'ps', 'lsof',
  'help', 'man', 'info',
])

/** Subcommands that make a command diagnostic even if the base isn't */
const DIAGNOSTIC_SUBCOMMANDS: Record<string, Set<string>> = {
  npm: new Set(['list', 'ls', 'view', 'info', 'show', 'config', 'root', 'prefix', 'bin', 'help', '--version', '-v']),
  node: new Set(['--version', '-v', '-e', '--eval', '-p', '--print']),
  python: new Set(['--version', '-V', '-c']),
  python3: new Set(['--version', '-V', '-c']),
  pip: new Set(['list', 'show', 'freeze', '--version']),
  pip3: new Set(['list', 'show', 'freeze', '--version']),
  git: new Set(['status', 'log', 'branch', 'remote', 'config', 'diff', 'show', 'ls-files', 'rev-parse']),
  cargo: new Set(['--version', 'metadata']),
  yarn: new Set(['list', 'info', 'why', '--version']),
  pnpm: new Set(['list', 'ls', 'why', '--version']),
  bun: new Set(['--version', 'pm']),
  npx: new Set(['--help']),
}

const _failures = new Map<string, FailureEntry>()

interface IntentEntry {
  /** Sorted, deduped, joined list of executables in the command chain */
  key: string
  /** Distinct exact commands that have failed under this intent */
  commands: string[]
  /** First failure timestamp (for TTL) */
  firstAttempt: number
  /** Last failure timestamp */
  lastAttempt: number
  /** Last exit code (for the block message) */
  lastExitCode: number
}

const _intentFailures = new Map<string, IntentEntry>()

/**
 * Extract a normalized "signature" from a command for fuzzy matching.
 * Strips whitespace variations, trailing flags, and normalizes paths.
 */
function commandSignature(command: string, workdir?: string): string {
  const normalizedCommand = command
    .trim()
    .replace(/\s+/g, ' ')      // normalize whitespace
    .replace(/\s+2>&1\s*$/, '') // strip trailing 2>&1
    .replace(/\s*;\s*$/, '')    // strip trailing semicolons
    .toLowerCase()
  return workdir ? `${workdir.toLowerCase()} :: ${normalizedCommand}` : normalizedCommand
}

/**
 * Extract the base command (first word) from a command string.
 */
function baseCommand(command: string): string {
  const trimmed = command.trim()
  // Skip leading env vars: VAR=val cmd
  const parts = trimmed.split(/\s+/)
  for (const part of parts) {
    if (!part.includes('=') || part.startsWith('-')) {
      return part.toLowerCase()
    }
  }
  return parts[0]?.toLowerCase() ?? ''
}

/**
 * Extract the set of executables invoked in a command chain. For
 * `source X && uvicorn Y`, returns `['source', 'uvicorn']`. Strips path
 * prefixes and .exe so `/usr/bin/git` and `git.exe` collapse to `git`.
 * Sorted + deduped so order doesn't matter for the intent key.
 */
export function extractExecutableSet(command: string): string[] {
  const trimmed = command.trim()
  if (!trimmed) return []

  // Split on shell metacharacters that separate commands.
  const clauses = trimmed.split(/[;|&]{1,2}|\n/)
  const exes = new Set<string>()

  for (const clause of clauses) {
    const parts = clause.trim().split(/\s+/)
    let i = 0
    // Skip leading env-var assignments
    while (i < parts.length && /^[A-Z_][A-Z0-9_]*=/.test(parts[i] ?? '')) i++
    const tok = parts[i]
    if (!tok) continue
    // Strip path + .exe
    const exe = tok.replace(/^.*[\\/]/, '').replace(/\.exe$/i, '').toLowerCase()
    // Skip empty / non-executable tokens
    if (!exe || /^[(){}<>"'`]/.test(exe)) continue
    exes.add(exe)
  }

  return [...exes].sort()
}

function intentKey(command: string): string {
  return extractExecutableSet(command).join('+')
}

function purgeStaleIntent(): void {
  const now = Date.now()
  for (const [key, entry] of _intentFailures) {
    if (now - entry.firstAttempt > INTENT_TTL_MS) {
      _intentFailures.delete(key)
    }
  }
}

function unquoteShellToken(token: string): string {
  const trimmed = token.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function extractCdTarget(command: string): string | undefined {
  const match = /(?:^|[;&|]\s*)cd\s+("[^"]+"|'[^']+'|[^\s;&|]+)/i.exec(
    command,
  )
  return match?.[1] ? unquoteShellToken(match[1]) : undefined
}

function shellQuoteForHint(value: string): string {
  if (/^[A-Za-z0-9_./:\\-]+$/.test(value)) return value
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function hasPackageManagerCommand(command: string): boolean {
  return /\b(npm|yarn|pnpm|bun|npx)\b/i.test(command)
}

/**
 * Check if a command is diagnostic in nature.
 */
function isDiagnosticCommand(command: string): boolean {
  const parts = command.trim().split(/\s+/)
  const base = baseCommand(command)

  // Direct diagnostic command
  if (DIAGNOSTIC_COMMANDS.has(base)) {
    // Check if it has a diagnostic subcommand
    const subCmds = DIAGNOSTIC_SUBCOMMANDS[base]
    if (subCmds) {
      // For commands like npm/git, only diagnostic if subcommand is diagnostic
      const sub = parts[1]?.toLowerCase()
      if (sub && subCmds.has(sub)) return true
      // `--version` / `--help` are always diagnostic
      if (parts.some(p => p === '--version' || p === '-v' || p === '--help' || p === '-h')) return true
      // For ls, cat, which, etc. the command itself is diagnostic
      if (!subCmds) return true
      // npm/git/python without diagnostic subcommand is NOT diagnostic
      return false
    }
    return true
  }

  // Any command with --help or --version is diagnostic
  if (parts.some(p => p === '--help' || p === '-h' || p === '--version')) return true

  return false
}

/**
 * Purge stale entries from the failure cache.
 */
function purgeStale(): void {
  const now = Date.now()
  for (const [sig, entry] of _failures) {
    if (now - entry.lastAttempt > FAILURE_TTL_MS) {
      _failures.delete(sig)
    }
  }
  // Cap size
  if (_failures.size > MAX_TRACKED_FAILURES) {
    const sorted = [..._failures.entries()].sort((a, b) => a[1].lastAttempt - b[1].lastAttempt)
    for (let i = 0; i < sorted.length - MAX_TRACKED_FAILURES; i++) {
      _failures.delete(sorted[i]![0])
    }
  }
}

/**
 * Record a command failure. Called after a Bash command fails. Updates
 * both the per-signature tracker (exact-command retries) and the per-
 * intent tracker (same executable-set with cosmetic variations).
 */
export function recordBashFailure(command: string, exitCode: number, output: string, workdir?: string): void {
  purgeStale()
  const sig = commandSignature(command, workdir)
  const existing = _failures.get(sig)
  if (existing) {
    existing.attempts++
    existing.lastAttempt = Date.now()
    existing.exitCode = exitCode
    existing.lastOutput = output.slice(0, 300)
  } else {
    _failures.set(sig, {
      signature: sig,
      command,
      attempts: 1,
      lastAttempt: Date.now(),
      exitCode,
      lastOutput: output.slice(0, 300),
    })
  }

  // Intent tracking — sibling channel that catches cosmetic-variant thrashing.
  purgeStaleIntent()
  const ikey = intentKey(command)
  if (!ikey) return // empty / unparseable command
  const now = Date.now()
  const intent = _intentFailures.get(ikey)
  if (intent) {
    // Only count distinct commands toward the threshold so legitimate
    // exact-retries don't double-count against per-signature tracking.
    if (!intent.commands.includes(command)) {
      intent.commands.push(command)
    }
    intent.lastAttempt = now
    intent.lastExitCode = exitCode
  } else {
    _intentFailures.set(ikey, {
      key: ikey,
      commands: [command],
      firstAttempt: now,
      lastAttempt: now,
      lastExitCode: exitCode,
    })
  }
}

/**
 * Record a command success. Clears matching failure entries.
 * Also clears ALL failures if this was a diagnostic command
 * (the model is investigating, so let it retry after).
 */
export function recordBashSuccess(command: string, workdir?: string): void {
  const sig = commandSignature(command, workdir)
  _failures.delete(sig)

  // Intent tracker: if any executable in this command overlaps a tracked
  // intent set, drop that entry — a success on the same tool family is
  // strong evidence the model has converged on a working approach.
  const exes = new Set(extractExecutableSet(command))
  for (const [ikey, entry] of _intentFailures) {
    if (entry.key.split('+').some(e => exes.has(e))) {
      _intentFailures.delete(ikey)
    }
  }

  if (isDiagnosticCommand(command)) {
    // Diagnostic command ran — model is investigating. Clear all failures
    // so it can retry the original command with new knowledge.
    _failures.clear()
    _intentFailures.clear()
  }
}

/**
 * Compatibility seam for older callers. Repeated failures are diagnostic
 * state only and never produce a user-visible execution block.
 */
export function checkBashRetryGuard(_command: string, _workdir?: string): string | null {
  purgeStale()
  purgeStaleIntent()
  return null
}

/**
 * Build context-appropriate diagnostic suggestions based on the failing command.
 */
function buildDiagnosticSuggestions(command: string): string[] {
  const base = baseCommand(command)
  const suggestions: string[] = []
  const cdTarget = extractCdTarget(command)

  // Wrong directory is the most common cause of these retry loops — the model
  // is usually sitting in another project's root. Lead with the concrete escape
  // so it stops re-running the identical command: put the target's ABSOLUTE
  // path in the command or use the CLI's native location flag.
  suggestions.push(
    '- If this must target a different directory than the current one (e.g. another project/repo), retry with that directory\'s ABSOLUTE path in the command or the CLI\'s native location flag — do NOT repeat the identical bare command.',
  )

  if (cdTarget) {
    const quotedTarget = shellQuoteForHint(cdTarget)
    suggestions.push(
      '- Verify the current directory and cd target first: pwd && ls -la && test -d ' +
        quotedTarget +
        ' && ls -la ' +
        quotedTarget,
    )
  }

  // Package manager commands
  if (
    ['npm', 'yarn', 'pnpm', 'bun', 'npx'].includes(base) ||
    hasPackageManagerCommand(command)
  ) {
    suggestions.push(
      '- Check active directory: pwd && ls -la',
      '- Locate the real project manifest: find .. -maxdepth 4 -name package.json -not -path "*/node_modules/*"',
      '- Check if package.json exists: cat package.json',
      '- Check installed packages: npm list --depth=0',
      '- Check if the script exists: npm run --list',
      '- Check Node.js version: node --version',
    )
  }
  // Python commands
  else if (['python', 'python3', 'pip', 'pip3', 'pytest'].includes(base)) {
    suggestions.push(
      '- Check Python version: python3 --version',
      '- Check if module exists: python3 -c "import <module>"',
      '- Check installed packages: pip3 list',
      '- Verify the script path: ls -la <script_path>',
    )
  }
  // Git commands
  else if (base === 'git') {
    suggestions.push(
      '- Check git status: git status',
      '- Check current branch: git branch',
      '- Check if inside a repo: git rev-parse --git-dir',
    )
  }
  // Test runners
  else if (['jest', 'vitest', 'playwright', 'mocha'].includes(base)) {
    suggestions.push(
      '- Check if test framework is installed: npx ' + base + ' --version',
      '- List available test files: find . -name "*.test.*" -not -path "*/node_modules/*"',
      '- Check package.json test config: cat package.json',
    )
  }
  // Generic
  else {
    suggestions.push(
      '- Check if the command exists: which ' + base,
      '- Check current directory: pwd && ls -la',
      '- Check if target file/path exists: ls -la <target>',
      '- Read any config files: cat <config_file>',
    )
  }

  return suggestions
}

/**
 * Reset all tracked failures. Used when context is cleared.
 */
export function resetBashRetryGuard(): void {
  _failures.clear()
}
