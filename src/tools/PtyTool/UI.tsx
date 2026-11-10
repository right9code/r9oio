import * as React from 'react'

import { Box, Text } from '../../ink.js'
import type { Output } from './PtyTool.js'

// Per-line render with a sane ceiling so megabyte outputs from TUIs can't
// crash Ink the way a single huge <Text> node would.
const PREVIEW_LINES = 200
const PREVIEW_LINE_MAX_CHARS = 1000

export function renderToolUseMessage(input: {
  command?: string
  cwd?: string
}): React.ReactNode {
  if (!input.command) return ''
  const head =
    input.command.length > 80
      ? input.command.slice(0, 77) + '...'
      : input.command
  return head
}

function clipLine(line: string): string {
  if (line.length <= PREVIEW_LINE_MAX_CHARS) return line
  return line.slice(0, PREVIEW_LINE_MAX_CHARS) + '…'
}

export function renderToolResultMessage(output: Output): React.ReactNode {
  const flags: string[] = []
  if (output.timedOut) flags.push('timed out')
  if (output.aborted) flags.push('aborted')
  if (output.truncated) flags.push('truncated')
  const flagStr = flags.length ? ` (${flags.join(', ')})` : ''
  const status =
    output.exitCode === null
      ? `signal=${output.signal ?? 'unknown'}`
      : `exit=${output.exitCode}`

  const text = output.output ?? ''
  // Strip a trailing newline so we don't render an extra blank line at the
  // end of every command's output.
  const trimmed = text.endsWith('\n') ? text.slice(0, -1) : text
  const allLines = trimmed === '' ? [] : trimmed.split('\n')
  const showLast = allLines.length > PREVIEW_LINES
  const visibleLines = showLast ? allLines.slice(-PREVIEW_LINES) : allLines

  return (
    <Box flexDirection="column">
      {visibleLines.length > 0 ? (
        <Box flexDirection="column">
          {visibleLines.map((line, i) => (
            // Empty lines need a non-empty child to render with vertical
            // height in Ink; a single space is the standard trick.
            <Text key={i}>{line === '' ? ' ' : clipLine(line)}</Text>
          ))}
        </Box>
      ) : (
        <Text color="inactive">(no output)</Text>
      )}
      {showLast ? (
        <Text color="inactive">
          ... showing last {PREVIEW_LINES} of {allLines.length} lines (full
          output sent to the model).
        </Text>
      ) : null}
      <Text color={output.ok ? 'success' : 'error'}>
        {status} in {output.durationMs}ms{flagStr}
      </Text>
    </Box>
  )
}
