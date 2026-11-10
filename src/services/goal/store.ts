import type { GoalState } from './types.js'

// Session-scoped source of truth for the active goal.
//
// This is a module-level singleton rather than React app state on purpose:
// app-state writes made deep inside the query loop (where the goal check runs)
// do not reliably propagate back to the REPL command context, so a goal paused
// by the loop looked "cleared" to a later `/goal resume`. A process-global is
// correct here — the goal is a single-session, main-thread concept and subagents
// never touch it. Not persisted across resume in v1 (resets on process restart).

let currentGoal: GoalState | null = null

export function getGoal(): GoalState | null {
  return currentGoal
}

export function setGoal(goal: GoalState | null): void {
  currentGoal = goal
}
