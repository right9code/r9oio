/**
 * Best-effort, NON-BLOCKING syntax check for file edits.
 *
 * After an edit is applied, parse the new content with tree-sitter and compare
 * the error-node count against the pre-edit content. If — and only if — the
 * edit INTRODUCED new parse errors, return a short advisory string. The edit is
 * never blocked or reverted; this only annotates the tool result the model
 * sees.
 *
 * Delta comparison (not absolute count) is deliberate: it suppresses false
 * positives from grammar gaps, pre-existing errors, and unusual-but-valid code.
 * The check returns `undefined` whenever the language is unsupported, parsing
 * is unavailable, the file is too large, or the edit didn't make things worse.
 * It can therefore never spam you with spurious "syntax error" noise.
 */

import { extname } from 'node:path'
import { isSupportedLanguage, parse, type SyntaxNode } from './parser.js'

// File extension -> grammar key. Only high-confidence, single-language
// mappings with mature grammars. Ambiguous extensions (e.g. bare `.h`) are
// intentionally omitted to avoid noise.
const EXT_TO_LANGUAGE: Record<string, string> = {
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'javascript',
  '.py': 'python',
  '.pyi': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.rb': 'ruby',
  '.cs': 'c_sharp',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
  '.hpp': 'cpp',
  '.hh': 'cpp',
  '.css': 'css',
  '.php': 'php',
}

// Skip very large files — parse latency isn't worth it on the edit path.
const MAX_VALIDATE_BYTES = 2_000_000

/** Iterative (stack) walk counting ERROR + MISSING nodes. */
function countErrorNodes(root: SyntaxNode): number {
  let count = 0
  const stack: SyntaxNode[] = [root]
  while (stack.length > 0) {
    const node = stack.pop() as SyntaxNode
    if (node.isError || node.isMissing) count++
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i)
      if (child) stack.push(child)
    }
  }
  return count
}

/** Resolve a supported grammar key for a file path, or `undefined`. */
export function languageForPath(filePath: string): string | undefined {
  const lang = EXT_TO_LANGUAGE[extname(filePath).toLowerCase()]
  return lang && isSupportedLanguage(lang) ? lang : undefined
}

/**
 * Returns a short advisory string iff the edit introduced NEW parse errors,
 * else `undefined`. Never throws.
 */
export async function validateEditSyntax(
  filePath: string,
  before: string,
  after: string,
): Promise<string | undefined> {
  try {
    const language = languageForPath(filePath)
    if (!language) return undefined
    if (after.length > MAX_VALIDATE_BYTES) return undefined

    const afterTree = await parse(language, after)
    if (!afterTree) return undefined
    try {
      // Fast path: a clean parse means nothing to report — no full walk, no
      // "before" parse. The overwhelmingly common case exits here.
      if (!afterTree.rootNode.hasError) return undefined
      const afterErrors = countErrorNodes(afterTree.rootNode)

      // Only now pay for the "before" parse, to compute the delta.
      let beforeErrors = 0
      const beforeTree = await parse(language, before)
      if (beforeTree) {
        try {
          beforeErrors = beforeTree.rootNode.hasError
            ? countErrorNodes(beforeTree.rootNode)
            : 0
        } finally {
          beforeTree.delete()
        }
      }

      // The edit didn't make things worse — stay silent.
      if (afterErrors <= beforeErrors) return undefined

      const added = afterErrors - beforeErrors
      return `⚠ Syntax check (tree-sitter): this edit introduced ${added} new parse error${added === 1 ? '' : 's'}. The edit was still applied — review the file for an unbalanced bracket/quote or an incomplete statement if this was unintended.`
    } finally {
      afterTree.delete()
    }
  } catch {
    return undefined
  }
}
