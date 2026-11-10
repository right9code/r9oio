/** Encode one literal argument for a POSIX-compatible shell. */
export function quotePosixShellArgument(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

/** Build the managed-local launcher used by sh, including Git Bash on Windows. */
export function buildManagedLocalWrapper(
  localInstallDir: string,
  platform = process.platform,
): string {
  const shellDirectory =
    platform === 'win32'
      ? localInstallDir.replaceAll('\\', '/')
      : localInstallDir
  const target = `${shellDirectory.replace(/\/+$/, '')}/node_modules/.bin/tau`
  return `#!/bin/sh\nexec ${quotePosixShellArgument(target)} "$@"\n`
}
