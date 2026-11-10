import { UpdateLock } from './updateLock.js'

export type ManagedLocalInstallStatus =
  | 'in_progress'
  | 'success'
  | 'install_failed'

type ManagedLocalUpdateLease = Pick<
  UpdateLock,
  'acquire' | 'release' | 'startHeartbeat'
>

/** Serialize the complete managed-local package mutation under one lease. */
export async function withManagedLocalUpdateLock(
  operation: () => Promise<ManagedLocalInstallStatus>,
  lock: ManagedLocalUpdateLease,
): Promise<ManagedLocalInstallStatus> {
  if (!(await lock.acquire())) return 'in_progress'

  let stopHeartbeat: (() => Promise<void>) | undefined
  try {
    stopHeartbeat = lock.startHeartbeat()
    return await operation()
  } finally {
    try {
      await stopHeartbeat?.()
    } finally {
      await lock.release()
    }
  }
}
