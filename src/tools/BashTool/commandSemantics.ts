/**
 * Command semantics configuration for interpreting exit codes in different contexts.
 *
 * Many commands use exit codes to convey information other than just success/failure.
 * For example, grep returns 1 when no matches are found, which is not an error condition.
 */

export type CommandSemantic = (
  exitCode: number,
  stdout: string,
  stderr: string,
) => {
  isError: boolean
  message?: string
}

/**
 * Default semantic: treat only 0 as success, everything else as error
 */
const DEFAULT_SEMANTIC: CommandSemantic = (exitCode, _stdout, _stderr) => ({
  isError: exitCode !== 0,
  message:
    exitCode !== 0 ? `Command failed with exit code ${exitCode}` : undefined,
})

/**
 * Command-specific semantics
 */
const COMMAND_SEMANTICS: Map<string, CommandSemantic> = new Map([
  // grep: 0=matches found, 1=no matches, 2+=error
  [
    'grep',
    (exitCode, _stdout, _stderr) => ({
      isError: exitCode >= 2,
      message: exitCode === 1 ? 'No matches found' : undefined,
    }),
  ],

  // ripgrep has same semantics as grep
  [
    'rg',
    (exitCode, _stdout, _stderr) => ({
      isError: exitCode >= 2,
      message: exitCode === 1 ? 'No matches found' : undefined,
    }),
  ],

  // find: 0=success, 1=partial success (some dirs inaccessible), 2+=error
  [
    'find',
    (exitCode, _stdout, _stderr) => ({
      isError: exitCode >= 2,
      message:
        exitCode === 1 ? 'Some directories were inaccessible' : undefined,
    }),
  ],

  // diff: 0=no differences, 1=differences found, 2+=error
  [
    'diff',
    (exitCode, _stdout, _stderr) => ({
      isError: exitCode >= 2,
      message: exitCode === 1 ? 'Files differ' : undefined,
    }),
  ],

  // cmp: 0=files equal, 1=files differ, 2+=error
  [
    'cmp',
    (exitCode, _stdout, _stderr) => ({
      isError: exitCode >= 2,
      message: exitCode === 1 ? 'Files differ' : undefined,
    }),
  ],

  // test/[: 0=condition true, 1=condition false, 2+=error
  [
    'test',
    (exitCode, _stdout, _stderr) => ({
      isError: exitCode >= 2,
      message: exitCode === 1 ? 'Condition is false' : undefined,
    }),
  ],

  // [ is an alias for test
  [
    '[',
    (exitCode, _stdout, _stderr) => ({
      isError: exitCode >= 2,
      message: exitCode === 1 ? 'Condition is false' : undefined,
    }),
  ],

  // wc, head, tail, cat, etc.: these typically only fail on real errors
  // so we use default semantics
])

/**
 * Get the semantic interpretation for a command
 */
function getCommandSemantic(command: string): CommandSemantic {
  // Extract the base command (first word, handling pipes)
  const baseCommand = heuristicallyExtractBaseCommand(command)
  const semantic = COMMAND_SEMANTICS.get(baseCommand)
  return semantic !== undefined ? semantic : DEFAULT_SEMANTIC
}

/**
 * Extract just the command name (first word) from a single command string.
 */
function extractBaseCommand(command: string): string {
  const parts = command.trim().split(/\s+/).filter(Boolean)
  while (parts.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(parts[0]!)) {
    parts.shift()
  }
  return parts[0] || ''
}

function splitCommandForSemantics(command: string): string[] {
  const segments: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let escaped = false

  function pushCurrent(): void {
    const segment = current.trim()
    if (segment) segments.push(segment)
    current = ''
  }

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!
    const next = command[i + 1]

    if (escaped) {
      current += ch
      escaped = false
      continue
    }

    if (ch === '\\') {
      current += ch
      escaped = true
      continue
    }

    if (quote) {
      current += ch
      if (ch === quote) quote = null
      continue
    }

    if (ch === '"' || ch === "'") {
      quote = ch
      current += ch
      continue
    }

    if (ch === ';' || ch === '\n' || ch === '|') {
      pushCurrent()
      if (ch === '|' && next === '|') i++
      continue
    }

    if (ch === '&') {
      if (next === '&') {
        pushCurrent()
        i++
        continue
      }
      if (command[i - 1] === '>' || command[i - 1] === '<') {
        current += ch
        continue
      }
      pushCurrent()
      continue
    }

    current += ch
  }

  pushCurrent()
  return segments.length > 0 ? segments : [command]
}

/**
 * Extract the primary command from a complex command line;
 * May get it super wrong - don't depend on this for security
 */
function heuristicallyExtractBaseCommand(command: string): string {
  const segments = splitCommandForSemantics(command)

  // Take the last command as that's what determines the exit code
  const lastCommand = segments[segments.length - 1] || command

  return extractBaseCommand(lastCommand)
}

/**
 * Interpret command result based on semantic rules
 */
export function interpretCommandResult(
  command: string,
  exitCode: number,
  stdout: string,
  stderr: string,
): {
  isError: boolean
  message?: string
} {
  const semantic = getCommandSemantic(command)
  const result = semantic(exitCode, stdout, stderr)

  return {
    isError: result.isError,
    message: result.message,
  }
}
