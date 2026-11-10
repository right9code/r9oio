import { BASH_TOOL_NAME } from '../../tools/BashTool/toolName.js'

export const POWERSHELL_TOOL_NAME = 'PowerShell'
export const SHELL_TOOL_NAMES: string[] = [BASH_TOOL_NAME]

export function isPowerShellToolEnabled(): boolean {
  return false
}
