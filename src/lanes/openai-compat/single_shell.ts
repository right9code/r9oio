/**
 * Single-shell filter for the openai-compat lane.
 *
 * Background: claudex exposes BOTH `BashTool` and `PowerShellTool` on
 * Windows when (a) git-bash is installed AND (b) PowerShellTool is
 * gated on (ant users by default, external users via
 * `CLAUDE_CODE_USE_POWERSHELL_TOOL=1`). Frontier models can decide
 * which one to use based on context; weak models on the compat lane
 * (DeepSeek, GLM, Moonshot, MiniMax, Groq long-tail) routinely pick
 * the wrong one mid-session and emit cross-shell syntax — `&&` chained
 * commands sent to PowerShell 5.1, `$env:VAR` sent to bash, etc.
 *
 * Strategy: when both tools are in the array passed to the lane, keep
 * exactly one. Pick based on the user's environment, with PowerShell
 * winning on Windows by default (it's the always-available shell).
 *
 * Selection order (first match wins):
 *   1. `CLAUDE_CODE_SHELL` env points to a shell binary → keep that
 *      shell's tool. Lets users with a strong preference override.
 *   2. Non-Windows platform → keep Bash (PowerShell is exotic).
 *   3. `$SHELL` env points to bash AND git-bash is on PATH → keep Bash.
 *   4. Otherwise (Windows default) → keep PowerShell.
 *
 * Caller: invoke once per request from `streamAsProvider`, AFTER the
 * transformer's `filterTools()` hook so per-model tool budgets still
 * win.
 */

import { findGitBashPath } from '../../utils/windowsPaths.js'
import { getPlatform } from '../../utils/platform.js'

interface Named {
  name: string
}

const BASH_NAME = 'Bash'
const PS_NAME = 'PowerShell'

/**
 * If both shell tools are present, drop one and return a new array.
 * If only one (or neither) is present, returns the input unchanged.
 */
export function filterToSingleShell<T extends Named>(tools: T[]): T[] {
  const hasBash = tools.some(t => t.name === BASH_NAME)
  const hasPS = tools.some(t => t.name === PS_NAME)
  if (!hasBash || !hasPS) return tools

  const keep = pickPreferredShell()
  const drop = keep === BASH_NAME ? PS_NAME : BASH_NAME
  return tools.filter(t => t.name !== drop)
}

/**
 * Internal — exported only for the regression test.
 */
export function pickPreferredShell(): typeof BASH_NAME | typeof PS_NAME {
  const override = process.env.CLAUDE_CODE_SHELL?.toLowerCase() ?? ''
  if (override.includes('powershell') || override.includes('pwsh')) {
    return PS_NAME
  }
  if (
    override.includes('bash') ||
    override.endsWith('/sh') ||
    override.endsWith('/zsh')
  ) {
    return BASH_NAME
  }

  if (getPlatform() !== 'windows') {
    return BASH_NAME
  }

  const userShell = process.env.SHELL?.toLowerCase() ?? ''
  if (userShell.includes('bash') && findGitBashPath() !== null) {
    return BASH_NAME
  }

  return PS_NAME
}
