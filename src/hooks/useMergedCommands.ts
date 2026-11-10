import uniqBy from 'lodash-es/uniqBy.js'
import { useMemo } from 'react'
import type { Command } from '../commands.js'
import { useAppState } from '../state/AppState.js'
import { getPowerModeFromSettings } from '../utils/powerMode.js'

export function useMergedCommands(
  initialCommands: Command[],
  mcpCommands: Command[],
): Command[] {
  // Cheap power mode ignores MCP entirely, including MCP-provided commands
  // from servers that connected before a mid-session mode switch.
  const powerMode = useAppState(s => getPowerModeFromSettings(s.settings))
  return useMemo(() => {
    if (mcpCommands.length > 0 && powerMode !== 'cheap') {
      return uniqBy([...initialCommands, ...mcpCommands], 'name')
    }
    return initialCommands
  }, [initialCommands, mcpCommands, powerMode])
}
