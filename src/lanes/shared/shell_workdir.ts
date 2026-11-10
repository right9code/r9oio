/**
 * Shared compatibility for legacy "run this command in a directory" parameters
 * on lane-native shell tools.
 *
 * Background:
 * Earlier lane schemas exposed directory knobs (`workdir`, `dir_path`, `cwd`)
 * so models could recover from wrong-cwd commands. That fixed one class of
 * loop but taught models to depend on a separate execution-directory field
 * instead of putting the target path in the command. The Bash/PowerShell
 * resolvers now auto-locate common targets and bake absolute paths/native CLI
 * location flags into the command string, so the model-facing schema should not
 * advertise a second directory control surface.
 *
 * The shared Bash/PowerShell impls already have a first-class `workdir`
 * field that is strictly better than a cd-prefix:
 *   - quoting-safe (no hand-quoting paths with spaces; on Windows the
 *     backslashes in a `cd "C:\…"` prefix are bash escapes),
 *   - one-off — it does NOT change the session cwd (a synthesized
 *     `cd X && …` is treated by BashTool as a real shell move and
 *     persists the cwd, which is a surprising side effect),
 *   - understood by the workdir preflight + the cwd-transparency note.
 *
 * Current contract:
 *   1. do NOT advertise a directory parameter in the schema the model sees;
 *      prompts should teach absolute paths or native CLI location flags instead.
 *   2. if an older provider shim still sends a directory key, map it to the
 *      shared impl's internal `workdir` field — never to a `cd …` prefix.
 *
 * Lanes keep their NATIVE parameter name (the model was post-trained on
 * it); only the mapping target is standardized. New lanes should reuse
 * the helpers here so the contract can't drift again. The cross-lane test
 * in shell_workdir.test.ts enforces it.
 */

/** Deprecated legacy description. New model-facing shell schemas should not
 * expose a directory parameter. */
export const SHELL_WORKDIR_PARAM_DESCRIPTION =
  'Deprecated legacy directory parameter. Prefer absolute paths or native CLI location flags in the command.'

/**
 * Legacy JSON-Schema property fragment for compatibility only. New shell tool
 * schemas should not spread this into model-facing properties.
 */
export function shellWorkdirSchemaProperty(
  description: string = SHELL_WORKDIR_PARAM_DESCRIPTION,
): Record<string, unknown> {
  return { type: 'string', description }
}

/**
 * Native key names lanes use for "the directory to run in". The shared
 * impl's own field (`workdir`) is listed first so an explicit workdir
 * always wins, followed by the per-lane aliases.
 */
export const SHELL_WORKDIR_INPUT_KEYS = [
  'workdir',
  'dir_path',
  'cwd',
  'directory',
] as const

/**
 * Copy the directory value from whichever native key the lane used onto
 * the shared impl's `workdir` field. Mutates and returns `out`.
 *
 * Never emits a `cd <dir> && …` prefix — that is the whole point. If no
 * directory key is present (or it is blank), `out` is returned unchanged.
 *
 * @param out    the shared-impl input being assembled (already has `command`).
 * @param native the model's raw tool-call arguments.
 * @param keys   candidate native key names, in priority order.
 */
export function applyShellWorkdir(
  out: Record<string, unknown>,
  native: Record<string, unknown>,
  keys: readonly string[] = SHELL_WORKDIR_INPUT_KEYS,
): Record<string, unknown> {
  for (const key of keys) {
    const value = native[key]
    if (typeof value === 'string' && value.trim().length > 0) {
      out.workdir = value
      return out
    }
  }
  return out
}
