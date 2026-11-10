import type { UUID } from 'crypto'
import { getOriginalCwd } from '../bootstrap/state.js'
import type { LogOption } from '../types/logs.js'
import { getWorktreePaths } from './getWorktreePaths.js'
import {
  getSessionIdFromLog,
  loadSameRepoMessageLogs,
} from './sessionStorage.js'
import { readSessionLite } from './sessionStoragePortable.js'

/**
 * One node in the cross-session forest. Children are sessions whose first
 * non-meta transcript message has `forkedFrom.sessionId === this.sessionId`.
 *
 * The tree is purely a derived view — nothing is persisted. Building it
 * never modifies any session file.
 */
export type SessionTreeNode = {
  sessionId: UUID
  /** Lite or full LogOption for this session (already filtered for resumability). */
  log: LogOption
  children: SessionTreeNode[]
}

/**
 * Flattened row produced by the tree walker. The renderer turns these into
 * lines like:  "├─ My Session    [12 msgs · 2h ago]".
 *
 * `gutters` records the indent positions where an ancestor still has more
 * siblings below — those positions need a "│" pipe in the prefix even though
 * the current row's connector belongs to a closer ancestor.
 */
export type FlatTreeNode = {
  node: SessionTreeNode
  /** 0-based depth (root = 0). */
  depth: number
  /** True when this row has a connector ("├─" or "└─"). False for roots. */
  showConnector: boolean
  /** When showConnector: true ⇒ "└─", false ⇒ "├─". */
  isLast: boolean
  /** Depths at which a "│" pipe must be drawn in the gutter prefix. */
  gutters: Set<number>
}

/**
 * Read just the head of a JSONL session file and pull `forkedFrom.sessionId`
 * from the first message that has it.
 *
 * Branch.ts writes `forkedFrom` on every cloned/branched message, so the very
 * first line that's a transcript message will carry the parent pointer for
 * forks. Sessions started fresh have no `forkedFrom` and become tree roots.
 *
 * Returns null when the file can't be read or has no `forkedFrom` (i.e. it's
 * a root session).
 */
async function readForkParentFromHead(
  filePath: string,
): Promise<UUID | null> {
  const lite = await readSessionLite(filePath)
  if (!lite) return null

  const head = lite.head
  // forkedFrom is nested ({"forkedFrom":{"sessionId":"...","messageUuid":"..."}})
  // We only need the sessionId. extractJsonStringField won't dive into nested
  // objects, so do a targeted scan: find "forkedFrom":{ and then "sessionId":"...".
  let cursor = 0
  while (cursor < head.length) {
    const idx = head.indexOf('"forkedFrom"', cursor)
    if (idx < 0) return null
    // Find the colon then opening brace
    const colon = head.indexOf(':', idx)
    if (colon < 0) return null
    let i = colon + 1
    while (i < head.length && (head[i] === ' ' || head[i] === '\t')) i++
    if (head[i] !== '{') {
      cursor = idx + 1
      continue
    }
    // Now scan within {...} for "sessionId":"..."
    const sessionKeyIdx = head.indexOf('"sessionId"', i)
    if (sessionKeyIdx < 0) return null
    const valueColon = head.indexOf(':', sessionKeyIdx)
    if (valueColon < 0) return null
    let j = valueColon + 1
    while (j < head.length && (head[j] === ' ' || head[j] === '\t')) j++
    if (head[j] !== '"') return null
    const valueStart = j + 1
    let k = valueStart
    while (k < head.length && head[k] !== '"') {
      if (head[k] === '\\') k += 2
      else k++
    }
    if (k >= head.length) return null
    return head.slice(valueStart, k) as UUID
  }
  return null
}

/**
 * Build the cross-session forest for the active project.
 *
 * Sessions reachable via worktrees are included so a forked session that
 * lives under a sibling worktree still appears next to its parent.
 *
 * The returned roots are sorted newest-first by `modified`, and each node's
 * children are sorted oldest-first so the visual reads top-down: parent at
 * top, descendants beneath, newest siblings later.
 */
export async function buildSessionForest(
  cwd: string = getOriginalCwd(),
): Promise<SessionTreeNode[]> {
  const worktreePaths = await getWorktreePaths(cwd)
  const logs = await loadSameRepoMessageLogs(worktreePaths)

  // Map sessionId → node (defensive against duplicates from worktree overlap).
  const byId = new Map<UUID, SessionTreeNode>()
  for (const log of logs) {
    if (log.isSidechain) continue
    const sessionId = getSessionIdFromLog(log)
    if (!sessionId) continue
    if (!byId.has(sessionId)) {
      byId.set(sessionId, { sessionId, log, children: [] })
    }
  }

  if (byId.size === 0) return []

  // Resolve parent for every session by reading its file head.
  const parentLookups = await Promise.all(
    Array.from(byId.values()).map(async (node) => {
      if (!node.log.fullPath) return [node.sessionId, null] as const
      const parent = await readForkParentFromHead(node.log.fullPath)
      return [node.sessionId, parent] as const
    }),
  )

  const roots: SessionTreeNode[] = []
  for (const [sessionId, parentId] of parentLookups) {
    const node = byId.get(sessionId)!
    if (parentId && byId.has(parentId)) {
      byId.get(parentId)!.children.push(node)
    } else {
      // No parent, or parent isn't loaded (e.g. forked from a session in a
      // different project). Treat as a root.
      roots.push(node)
    }
  }

  // Sort: roots newest-first; children oldest-first within each parent.
  roots.sort((a, b) => b.log.modified.getTime() - a.log.modified.getTime())
  const stack: SessionTreeNode[] = [...roots]
  while (stack.length > 0) {
    const node = stack.pop()!
    node.children.sort(
      (a, b) => a.log.modified.getTime() - b.log.modified.getTime(),
    )
    stack.push(...node.children)
  }

  return roots
}

/**
 * Depth-first flatten of the forest into rows for rendering.
 *
 * Iterative + an explicit stack to avoid blowing the JS call stack on deep
 * fork chains, and a per-row `gutters` set so the renderer can lay down the
 * "│" pipes at the correct indents.
 */
export function flattenForest(roots: SessionTreeNode[]): FlatTreeNode[] {
  const out: FlatTreeNode[] = []
  type Frame = {
    node: SessionTreeNode
    depth: number
    showConnector: boolean
    isLast: boolean
    gutters: Set<number>
  }
  const stack: Frame[] = []
  for (let i = roots.length - 1; i >= 0; i--) {
    stack.push({
      node: roots[i]!,
      depth: 0,
      showConnector: false,
      isLast: i === roots.length - 1,
      gutters: new Set(),
    })
  }
  while (stack.length > 0) {
    const frame = stack.pop()!
    out.push({
      node: frame.node,
      depth: frame.depth,
      showConnector: frame.showConnector,
      isLast: frame.isLast,
      gutters: frame.gutters,
    })
    const children = frame.node.children
    if (children.length === 0) continue
    // Children get a gutter at the parent's depth ONLY IF the parent isn't
    // the last sibling (otherwise the column underneath it is empty).
    const childGutters = new Set(frame.gutters)
    if (frame.depth > 0 || frame.showConnector) {
      const parentColumn = frame.depth
      if (!frame.isLast) {
        childGutters.add(parentColumn)
      } else {
        childGutters.delete(parentColumn)
      }
    }
    for (let i = children.length - 1; i >= 0; i--) {
      stack.push({
        node: children[i]!,
        depth: frame.depth + 1,
        showConnector: true,
        isLast: i === children.length - 1,
        gutters: childGutters,
      })
    }
  }
  return out
}

/**
 * Build the prefix string ("│  ├─ ", "│  │  └─ ", etc.) for a flattened row.
 *
 * `width` defaults to 3 columns per depth which matches pi-mono's
 * tree-selector and reads well in a typical 80-col terminal.
 */
export function renderTreePrefix(row: FlatTreeNode, width = 3): string {
  if (row.depth === 0) return ''
  let out = ''
  for (let d = 0; d < row.depth - 1; d++) {
    if (row.gutters.has(d)) {
      out += '│' + ' '.repeat(width - 1)
    } else {
      out += ' '.repeat(width)
    }
  }
  if (row.showConnector) {
    out += row.isLast ? '└─ ' : '├─ '
  } else {
    out += ' '.repeat(width)
  }
  return out
}
