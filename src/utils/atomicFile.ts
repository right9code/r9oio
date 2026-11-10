import { randomUUID } from 'crypto'
import { open, rename, unlink } from 'fs/promises'
import { basename, dirname, join } from 'path'
import { getErrnoCode } from './errors.js'

/**
 * Atomically replace a UTF-8 text file without exposing partial contents to
 * concurrent readers. The temporary file lives beside the destination so the
 * final rename stays on the same filesystem.
 */
export async function atomicReplaceTextFile(
  path: string,
  content: string,
): Promise<void> {
  const tempPath = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  )
  let tempFile: Awaited<ReturnType<typeof open>> | undefined
  let tempCreated = false
  let replacementError: unknown

  try {
    tempFile = await open(tempPath, 'wx')
    tempCreated = true
    await tempFile.writeFile(content, { encoding: 'utf8' })
    // Make the complete contents durable before the atomic name swap.
    await tempFile.sync()
    await tempFile.close()
    tempFile = undefined
    await rename(tempPath, path)
    return
  } catch (error) {
    replacementError = error
  }

  const cleanupErrors: unknown[] = []
  if (tempFile) {
    try {
      await tempFile.close()
    } catch (error) {
      cleanupErrors.push(error)
    }
  }
  if (tempCreated) {
    try {
      await unlink(tempPath)
    } catch (error) {
      if (getErrnoCode(error) !== 'ENOENT') cleanupErrors.push(error)
    }
  }

  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      [replacementError, ...cleanupErrors],
      `Failed to atomically replace ${path} and clean up its temporary file`,
    )
  }
  throw replacementError
}
