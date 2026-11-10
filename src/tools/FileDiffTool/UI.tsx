import { parsePatch, type StructuredPatchHunk } from 'diff'
import * as React from 'react'

import { StructuredDiff } from '../../components/StructuredDiff.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { Box, Text } from '../../ink.js'
import type { Output } from './FileDiffTool.js'

export function renderToolUseMessage(input: {
  fileA?: string
  fileB?: string
}): React.ReactNode {
  if (!input.fileA || !input.fileB) return 'diff'
  return `${input.fileA} ↔ ${input.fileB}`
}

export function renderToolResultMessage(output: Output): React.ReactNode {
  if (!output.ok) {
    return <Text color="error">{output.summary}</Text>
  }
  if (!output.patch || output.patch.trim() === '') {
    // identical, or too large to render — show the one-line summary
    return <Text color="inactive">{output.summary}</Text>
  }
  return <FileDiffView output={output} />
}

/**
 * Same unified, syntax-highlighted (red/green/yellow) diff used for snapshots —
 * one {@link StructuredDiff} per hunk, sized to the terminal.
 */
function FileDiffView({ output }: { output: Output }): React.ReactNode {
  const { columns } = useTerminalSize()
  let hunks: StructuredPatchHunk[] = []
  try {
    hunks = (parsePatch(output.patch ?? '')[0]?.hunks ??
      []) as StructuredPatchHunk[]
  } catch {
    hunks = []
  }
  return (
    <Box flexDirection="column">
      <Text>
        <Text color="error">{output.fileA}</Text>
        {' → '}
        <Text color="success">{output.fileB}</Text>
        {`  +${output.additions ?? 0} -${output.deletions ?? 0}`}
      </Text>
      {hunks.map((h, i) => (
        <StructuredDiff
          key={i}
          patch={h}
          filePath={output.fileB ?? ''}
          firstLine={null}
          dim={false}
          width={Math.max(1, columns - 4)}
        />
      ))}
    </Box>
  )
}
