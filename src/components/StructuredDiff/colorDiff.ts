import {
  ColorDiff,
  ColorFile,
  getSyntaxTheme as nativeGetSyntaxTheme,
  highlightCodeToAnsi,
  type SyntaxTheme,
} from 'color-diff-napi'
import { isEnvDefinedFalsy } from '../../utils/envUtils.js'

export type ColorModuleUnavailableReason = 'env'

/**
 * Returns a static reason why the color-diff module is unavailable, or null if available.
 * 'env' = disabled via CLAUDE_CODE_SYNTAX_HIGHLIGHT
 *
 * The TS port of color-diff works in all build modes, so the only way to
 * disable it is via the env var.
 */
export function getColorModuleUnavailableReason(): ColorModuleUnavailableReason | null {
  if (isEnvDefinedFalsy(process.env.CLAUDE_CODE_SYNTAX_HIGHLIGHT)) {
    return 'env'
  }
  return null
}

export function expectColorDiff(): typeof ColorDiff | null {
  return getColorModuleUnavailableReason() === null ? ColorDiff : null
}

export function expectColorFile(): typeof ColorFile | null {
  return getColorModuleUnavailableReason() === null ? ColorFile : null
}

export function getSyntaxTheme(themeName: string): SyntaxTheme | null {
  return getColorModuleUnavailableReason() === null
    ? nativeGetSyntaxTheme(themeName)
    : null
}

/**
 * In-process syntax highlighting of a code string → ANSI, for markdown code
 * blocks. Runs highlight.js in-process (no subprocess), so it colors streamed
 * code without the render-loop freeze the native subprocess highlighter caused.
 * Respects the CLAUDE_CODE_SYNTAX_HIGHLIGHT disable like the entry points above;
 * returns the code unchanged when disabled or the language is unknown.
 */
export function highlightCode(
  code: string,
  language: string | null,
  themeName: string,
): string {
  if (getColorModuleUnavailableReason() !== null) return code
  return highlightCodeToAnsi(code, language, themeName)
}
