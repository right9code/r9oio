/**
 * Swarm worker registry.
 *
 * Tracks the servant workers deployed for the active swarm session so
 * `/swarm status` can answer the user's core question: "are servants
 * actually deployed, and which model is each one running?"
 *
 * This is a leaf module: it must not import AgentTool or swarmManager so
 * both of those can depend on it without creating a cycle. AgentTool
 * reports master-initiated spawns through the setSwarmSpawnRecorder hook
 * (registered lazily at runtime) rather than a static import.
 */

export type SwarmWorkerStatus = 'running' | 'completed' | 'failed'

export type SwarmWorkerRecord = {
  /** Agent tool `name` — also the registry key (e.g. 'swarm-task-1'). */
  name: string
  provider: string
  modelId: string
  /** CoordinationHub task id this worker was dispatched for, if any. */
  taskId?: string
  /** Background task id from registerAsyncAgent (AppState.tasks key). */
  agentId?: string
  status: SwarmWorkerStatus
  startedAt: number
  /** Short summary of the dispatched work item. */
  promptSummary: string
  error?: string
}

const workers = new Map<string, SwarmWorkerRecord>()

export function registerSwarmWorker(record: SwarmWorkerRecord): void {
  workers.set(record.name, record)
}

export function updateSwarmWorker(
  name: string,
  patch: Partial<Omit<SwarmWorkerRecord, 'name'>>,
): void {
  const existing = workers.get(name)
  if (!existing) return
  workers.set(name, { ...existing, ...patch, name: existing.name })
}

export function getSwarmWorker(name: string): SwarmWorkerRecord | undefined {
  return workers.get(name)
}

export function listSwarmWorkers(): SwarmWorkerRecord[] {
  return [...workers.values()]
}

export function clearSwarmWorkers(): void {
  workers.clear()
}

/**
 * Optional callback fired on every register so AgentTool can log
 * master-initiated spawns without statically importing this module.
 */
let spawnRecorder: ((record: SwarmWorkerRecord) => void) | null = null

export function setSwarmSpawnRecorder(
  fn: ((record: SwarmWorkerRecord) => void) | null,
): void {
  spawnRecorder = fn
}

function fireRecorder(record: SwarmWorkerRecord): void {
  if (spawnRecorder) {
    try {
      spawnRecorder(record)
    } catch {
      // Recording must never break spawning.
    }
  }
}

/** registerSwarmWorker + recorder fire, for spawn sites. */
export function recordSwarmSpawn(record: SwarmWorkerRecord): void {
  registerSwarmWorker(record)
  fireRecorder(record)
}

/** Assign/reassign the background agent id once the tool call returns one. */
export function attachSwarmWorkerAgentId(name: string, agentId: string): void {
  updateSwarmWorker(name, { agentId })
}
