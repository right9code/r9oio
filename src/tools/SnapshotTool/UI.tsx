import { parsePatch, type StructuredPatchHunk } from 'diff'
import * as React from 'react'

import { StructuredDiff } from '../../components/StructuredDiff.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { Box, Text } from '../../ink.js'
import type { Output } from './SnapshotTool.js'

// Render at most this many files' diffs inline; the rest are summarized. The
// model still receives every file's patch via mapToolResultToToolResultBlockParam.
const MAX_VISUAL_FILES = 6

export function renderToolUseMessage(input: {
  action?: string
  hash?: string
  label?: string
}): React.ReactNode {
  const parts: string[] = []
  if (input.action) parts.push(input.action)
  if (input.hash) parts.push(input.hash.slice(0, 8))
  if (input.label) parts.push(`"${input.label}"`)
  return parts.join(' ')
}

function statusGlyph(status: 'added' | 'deleted' | 'modified'): string {
  return status === 'added' ? '+' : status === 'deleted' ? '-' : 'M'
}

function statusColor(
  status: 'added' | 'deleted' | 'modified',
): 'success' | 'error' | 'warning' {
  return status === 'added'
    ? 'success'
    : status === 'deleted'
      ? 'error'
      : 'warning'
}

export function renderToolResultMessage(output: Output): React.ReactNode {
  if (output.action === 'list') {
    if (!output.entries || output.entries.length === 0) {
      return <Text color="inactive">No snapshots</Text>
    }
    return (
      <Box flexDirection="column">
        {output.entries.map(e => (
          <Text key={e.hash}>
            {e.hash.slice(0, 8)}  {e.date}  {e.message}
          </Text>
        ))}
      </Box>
    )
  }
  if (output.action === 'diff') {
    const files = output.files ?? []
    if (files.length === 0) {
      return <Text color="inactive">No differences</Text>
    }
    return <SnapshotDiffView files={files} />
  }
  return <Text color={output.ok ? 'success' : 'error'}>{output.summary}</Text>
}

/**
 * Renders snapshot diffs visually: each file's hunks go through
 * {@link StructuredDiff} — the unified, syntax-highlighted (red/green/yellow)
 * diff, sized to the terminal so it stays readable at any window width.
 */
function SnapshotDiffView({
  files,
}: {
  files: NonNullable<Output['files']>
}): React.ReactNode {
  const { columns } = useTerminalSize()
  const shown = files.slice(0, MAX_VISUAL_FILES)
  const hidden = files.length - shown.length
  return (
    <Box flexDirection="column">
      <Text>
        {files.length} file{files.length === 1 ? '' : 's'} changed
      </Text>
      {shown.map(f => {
        const renderable = !f.binary && !f.truncated && f.patch.trim() !== ''
        let hunks: StructuredPatchHunk[] = []
        if (renderable) {
          try {
            hunks = (parsePatch(f.patch)[0]?.hunks ?? []) as StructuredPatchHunk[]
          } catch {
            hunks = []
          }
        }
        return (
          <Box key={f.file} flexDirection="column" marginTop={1}>
            <Text color={statusColor(f.status)}>
              {statusGlyph(f.status)}  {f.file}
              {'  '}
              {f.binary ? '(binary)' : `+${f.additions} -${f.deletions}`}
              {f.truncated ? '  [diff elided]' : ''}
            </Text>
            {hunks.map((h, i) => (
              <StructuredDiff
                key={i}
                patch={h}
                filePath={f.file}
                firstLine={null}
                dim={false}
                width={Math.max(1, columns - 4)}
              />
            ))}
          </Box>
        )
      })}
      {hidden > 0 && (
        <Text color="inactive">
          … {hidden} more file{hidden === 1 ? '' : 's'} not shown (full patches
          sent to the model).
        </Text>
      )}
    </Box>
  )
}
