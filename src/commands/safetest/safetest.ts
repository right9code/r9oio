import type { LocalJSXCommandCall } from '../../types/command.js'
import { getCwd } from '../../utils/cwd.js'
import { runSafetestFromArgs } from '../../utils/safetest/safetest.js'

export const call: LocalJSXCommandCall = async (onDone, _context, args) => {
  try {
    const result = await runSafetestFromArgs(args, getCwd())
    onDone(result.output, { shouldQuery: result.ranSandbox })
  } catch (error) {
    onDone(error instanceof Error ? error.message : String(error))
  }
  return null
}
