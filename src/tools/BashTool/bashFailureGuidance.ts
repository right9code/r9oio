import { getPlatform } from '../../utils/platform.js'

const MAX_OUTPUT_SAMPLE_CHARS = 1_200

type Platform = ReturnType<typeof getPlatform>

type FailurePattern = {
  pattern: RegExp
  reason: string
  guidance: string | ((platform: Platform) => string)
}

const FAILURE_PATTERNS: FailurePattern[] = [
  {
    pattern: /\b(command not found|not recognized as|no such command)\b/i,
    reason: 'The executable or subcommand was not found.',
    guidance:
      'Check the command name, PATH, active shell, container image, and whether the required tool is installed.',
  },
  {
    // Must precede the not-found pattern: Windows lock messages contain
    // "cannot access" ("The process cannot access the file because it is
    // being used by another process") and would be misclassified.
    pattern: /\b(device or resource busy|resource busy or locked|text file busy|EBUSY|ETXTBSY|being used by another process|EPERM: operation not permitted, (?:unlink|rename|rmdir))\b/i,
    reason: 'The target file, directory, or resource is held by a running process.',
    guidance: platform =>
      platform === 'windows'
        ? 'Find the specific process holding it before retrying: powershell.exe -Command "Get-NetTCPConnection -LocalPort <port>" for a busy port, or tasklist //FI "PID eq <pid>" (double slashes — Git Bash mangles single-slash flags); Git Bash has no lsof/fuser. Then stop only that PID: kill <PID> or powershell.exe -Command "Stop-Process -Id <PID> -Force" — never kill every process of an image name. Prefer starting long-running processes with run_in_background so they stay tracked and stoppable by task ID.'
        : 'Find the specific process holding it before retrying: lsof <path> or fuser <path>; for a busy port, lsof -i :<port> or fuser <port>/tcp. Then stop only that PID with kill <PID> — never kill every process of an image name (no broad killall/pkill). Prefer starting long-running processes with run_in_background so they stay tracked and stoppable by task ID.',
  },
  {
    pattern: /\bNo FileSystem for scheme\s*["']?C["']?|(?:CreateFile|stat|open|access).*?\bC:[\\/]|invalid (?:path|volume specification).*?\bC:[\\/]/i,
    reason: 'A POSIX path appears to have crossed a Windows/MSYS process boundary as a C: path.',
    guidance: platform =>
      platform === 'windows'
        ? 'Treat this as Git Bash/MSYS argument conversion, not a syntax or Compose-file-location error. Keep local host paths convertible, but exclude the remote argument from conversion or place the complete remote command in one quoted sh -c/bash -c string. For container, pod, SSH, WSL, ADB, or Hadoop paths, verify the target receives the original /path spelling.'
        : 'Inspect the process boundary that supplied the path. A target expecting a POSIX or URI path received a Windows drive-qualified path instead.',
  },
  {
    pattern: /\b(no such file or directory|cannot access|not found)\b/i,
    reason: 'A referenced file, directory, resource, or name was not found.',
    guidance:
      'First check the "Ran in" directory above: if the target lives elsewhere, retry with the target\'s absolute path or the command\'s native location/config flag. Otherwise list the parent location before retrying with a changed path or resource name.',
  },
  {
    pattern: /\b(permission denied|operation not permitted|access is denied)\b/i,
    reason: 'The command reached a permission boundary.',
    guidance:
      'Check ownership, user identity, sandbox/container permissions, and whether the operation needs a privileged context.',
  },
  {
    pattern: /\b(connection refused|could not connect|network is unreachable|temporary failure in name resolution|timeout)\b/i,
    reason: 'The command could not reach a service or network endpoint.',
    guidance:
      'Verify the service is running, the target host/port is correct, and network access is available before retrying.',
  },
  {
    pattern: /\b(usage:|invalid option|unknown option|unrecognized option|requires an argument|missing operand)\b/i,
    reason: 'The command-line interface rejected the arguments.',
    guidance:
      'Inspect the command help for this exact executable/version, then retry with the documented flags and argument order.',
  },
  {
    pattern: /\b(UnicodeEncodeError|codec can't encode character|charmap' codec can't encode|surrogates not allowed)\b/i,
    reason: 'The command failed while encoding text for stdout or stderr.',
    guidance:
      'Force the runtime output encoding to UTF-8 before retrying. For Python, use PYTHONIOENCODING=utf-8 or python -X utf8.',
  },
  {
    pattern: /\b(ModuleNotFoundError|ImportError: No module named|Cannot find module|ERR_MODULE_NOT_FOUND|module not found)\b/i,
    reason: 'The launched runtime could not find a required module or dependency.',
    guidance:
      'Verify the active interpreter/package manager environment, then install the missing dependency or run through the project environment.',
  },
  {
    pattern: /\b(Traceback \(most recent call last\)|SyntaxError|IndentationError|NameError|TypeError|ReferenceError|Exception in thread|NullPointerException)\b/i,
    reason: 'The shell launched the program, but the embedded runtime or script failed.',
    guidance:
      'Debug the reported runtime error directly. Do not keep changing shell quoting unless the traceback points to command-line parsing.',
  },
  {
    pattern: /\b(bad interpreter|env: .*\\r|bash\\r|sh\\r|\r: command not found)\b/i,
    reason: 'The script appears to have an invalid interpreter line or Windows CRLF line endings.',
    guidance:
      'Inspect the shebang and convert the script to LF line endings before retrying.',
  },
  {
    pattern: /\b(is not a tty|input device is not a TTY|inappropriate ioctl|pseudo-terminal|cannot perform an interactive login|interactive prompt)\b/i,
    reason: 'The command expected an interactive terminal or prompt.',
    guidance:
      'Use a non-interactive flag, provide input through stdin, or run the command in a context that allocates a TTY.',
  },
  {
    pattern: /\b(no space left on device|disk quota exceeded)\b/i,
    reason: 'The target filesystem is out of writable space or quota.',
    guidance:
      'Check available space and quotas before retrying the write operation.',
  },
  {
    pattern: /\b(file exists|already exists)\b/i,
    reason: 'The target already exists or the operation is not idempotent as written.',
    guidance:
      'Inspect the existing target and choose an idempotent flag, a different target, or a safe cleanup step.',
  },
]

function normalizeLine(line: string): string {
  return line.trim().replace(/\s+/g, ' ')
}

function commandOnlyOutput(command: string, output: string): boolean {
  const normalizedCommand = normalizeLine(command)
  const significantLines = output
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map(normalizeLine)
    .filter(Boolean)

  return (
    significantLines.length > 0 &&
    significantLines.every(line => line === normalizedCommand)
  )
}

function looksLikePythonCommand(command: string): boolean {
  return /(^|[\s;&|()])(?:python(?:\d+(?:\.\d+)?)?|py)(?:\.exe)?(?=\s|$)/i.test(
    command,
  )
}

function noDiagnosticGuidance(command: string): string {
  if (looksLikePythonCommand(command)) {
    return 'Do not retry near-identical commands. First run a targeted Python diagnostic under the same shell: check sys.executable, sys.stdout.encoding/sys.stderr.encoding, import availability, and a minimal traceback. On Windows, redirected Python output may need PYTHONIOENCODING=utf-8.'
  }
  return 'Do not retry near-identical commands. First run a targeted diagnostic that asks the relevant system for state, existence, permissions, or help output.'
}

function hasPipeline(command: string): boolean {
  return /(^|[^|])\|(?!\|)/.test(command)
}

function unquoteShellToken(token: string): string {
  const trimmed = token.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function shellQuoteForHint(value: string): string {
  if (/^[A-Za-z0-9_./:\\-]+$/.test(value)) return value
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function extractCdTarget(command: string): string | undefined {
  const match = /(?:^|[;&|]\s*)cd\s+("[^"]+"|'[^']+'|[^\s;&|]+)/i.exec(
    command,
  )
  return match?.[1] ? unquoteShellToken(match[1]) : undefined
}

function looksLikeProjectTaskCommand(command: string): boolean {
  return /\b(npm|yarn|pnpm|bun|npx|vite|tsc|eslint|pytest|cargo|mvn|gradle|make)\b|\bpackage\.json\b|\bfrontend\b|\bsrc[\\/]/i.test(
    command,
  )
}

// Tools that resolve their project/config from the working directory rather
// than from an argument (dvc → dvc.yaml, terraform → *.tf, docker compose →
// compose.yaml, …). When they fail there's no file path in argv to hint at the
// right place, and a wrong cwd (the model sitting in another project's root) is
// the usual cause — so steer to explicit absolute paths/native location flags
// instead of letting it loop on the bare command.
const CONFIG_IN_CWD_TOOLS_REGEX =
  /(^|[\s;&|(])(dvc|terraform|tofu|dbt|snakemake|ansible-playbook|pulumi|skaffold|vagrant|nox|tox)(\.exe)?(?=\s|$)|(^|[\s;&|(])docker[\s-]compose\b/i

// Process/network tools that exist only on one OS family. Used to redirect
// the model to the host's native equivalents instead of letting it retry a
// tool that can never exist there.
const WINDOWS_ONLY_TOOLS_REGEX =
  /(^|[\s;&|(])(tasklist|taskkill|ipconfig|findstr|robocopy|xcopy|schtasks|wmic|icacls|driverquery)(\.exe)?\b/i
const POSIX_ONLY_TOOLS_REGEX = /(^|[\s;&|(])(lsof|fuser)\b/i
const REMOTE_PATH_BOUNDARY_REGEX =
  /(^|[\s;&|(])(?:docker(?:\s+compose)?|docker-compose|podman|nerdctl)\s+(?:exec|run|cp)\b|(^|[\s;&|(])(?:kubectl|oc)\b[^;&|\n]*\b(?:exec|cp)\b|(^|[\s;&|(])(?:ssh|scp|sftp|rsync|wsl|adb|hadoop|hdfs)\b/i

function commandContextGuidance(command: string, platform: Platform): string[] {
  const hints: string[] = []

  if (platform !== 'windows' && WINDOWS_ONLY_TOOLS_REGEX.test(command)) {
    hints.push(
      'This command uses Windows-only tools that do not exist on this host. Use the native equivalents: ps aux / kill <PID> (processes), lsof -i :<port> (ports), ip addr or ifconfig (network), grep (search), cp -r or rsync (copy), chmod/chown (permissions), cron (scheduling).',
    )
  }

  if (platform === 'windows' && POSIX_ONLY_TOOLS_REGEX.test(command)) {
    hints.push(
      'lsof and fuser are not available in Git Bash. Use powershell.exe -Command "Get-NetTCPConnection -LocalPort <port>" for ports or "Get-Process -Id <pid>" for processes, then kill <PID> or Stop-Process -Id <PID>.',
    )
  }

  if (hasPipeline(command) && !/\bpipefail\b/.test(command)) {
    hints.push(
      'For pipelines, test each stage separately or rerun with set -o pipefail to expose the failing stage.',
    )
  }

  if (/\b2>\s*&\s*1\b/.test(command)) {
    hints.push(
      'The Bash tool already captures stderr; adding 2>&1 will not reveal hidden output if the program emitted none.',
    )
  }

  if (/[A-Za-z]:\\/.test(command)) {
    hints.push(
      'In Bash on Windows, prefer C:/path or /c/path over backslash paths unless every backslash is intentionally escaped.',
    )
  }

  if (platform === 'windows' && REMOTE_PATH_BOUNDARY_REGEX.test(command)) {
    hints.push(
      'This command crosses a Windows-to-POSIX path boundary. A direct /remote/path can be rewritten by Git Bash/MSYS before the native client sees it. Keep host paths convertible, protect only remote arguments, and use one quoted sh -c/bash -c remote command for dynamic paths, globs, redirects, or compound remote shell syntax.',
    )
  }

  if (
    /(?:^|\s)(?:--eval|--evaluate|--execute|--expression|-c|-e)(?:=|\s)/.test(
      command,
    )
  ) {
    hints.push(
      'This command passes source code through the shell. Verify the evaluator receives the program as one argument; nested JSON/BSON/code quotes should use a single-quoted payload, quoted heredoc, stdin, or a temporary file under $TMPDIR.',
    )
  }

  if (/--(?:file|config|input|output|script|workdir)=\S*[\\/]/.test(command)) {
    hints.push(
      'For path-valued long options, prefer the portable space-separated form (`--file /path`) over `--file=/path` unless this exact CLI documents equals-only syntax.',
    )
  }

  if (platform === 'windows' && /(?:^|\s)\/tmp(?:\/|\s|$)/.test(command)) {
    hints.push(
      'On Windows Git Bash, local /tmp and $TMPDIR refer to the native per-user host temp directory. A container/VM /tmp is a different filesystem; use docker/pod copy or stdin deliberately at that boundary.',
    )
  }

  const cdTarget = extractCdTarget(command)
  if (cdTarget) {
    const quotedTarget = shellQuoteForHint(cdTarget)
    hints.push(
      `This command depends on changing directories into ${quotedTarget}; before retrying, verify the active cwd and target with pwd && ls -la && test -d ${quotedTarget} && ls -la ${quotedTarget}. If the target is missing, locate the real project directory first. Once found, put that absolute path in the command or use the CLI's native location flag instead of repeating cd.`,
    )
  }

  if (CONFIG_IN_CWD_TOOLS_REGEX.test(command)) {
    hints.push(
      'This tool resolves its project/config from the working directory, not from an ordinary argument. If the project lives in a different directory than where this ran (above), retry with that project\'s ABSOLUTE path encoded in the command: use the CLI\'s native location flag when it has one (for example docker compose -f <absolute-compose-file>, terraform -chdir=<absolute-dir>, git -C <absolute-dir>, npm --prefix <absolute-dir>) or pass the absolute config/file path. Do not repeat the bare command.',
    )
  }

  if (looksLikeProjectTaskCommand(command)) {
    hints.push(
      "Resolve the project root before running build/test/package commands: use pwd && find .. -maxdepth 4 -name package.json -not -path '*/node_modules/*', then run the command from the directory containing the relevant manifest.",
    )
  }

  return hints
}

function appendCommandContextGuidance(
  guidance: string,
  command: string,
  platform: Platform,
): string {
  const hints = commandContextGuidance(command, platform)
  return hints.length > 0 ? `${guidance} ${hints.join(' ')}` : guidance
}

function sampleOutput(output: string): string {
  const trimmed = output.trim()
  if (!trimmed) return ''
  if (trimmed.length <= MAX_OUTPUT_SAMPLE_CHARS) return trimmed
  return `${trimmed.slice(0, MAX_OUTPUT_SAMPLE_CHARS).trimEnd()}\n...`
}

export function buildBashFailureGuidance(
  command: string,
  exitCode: number,
  output: string,
  ranIn?: string,
  platform: Platform = getPlatform(),
): string {
  const outputSample = sampleOutput(output)
  const effectiveOutput =
    outputSample && !commandOnlyOutput(command, outputSample) ? outputSample : ''
  const matched = effectiveOutput
    ? FAILURE_PATTERNS.find(({ pattern }) => pattern.test(effectiveOutput))
    : undefined

  const reason = matched?.reason ?? (effectiveOutput
    ? 'The command returned a nonzero exit code.'
    : 'The command returned a nonzero exit code without diagnostic output.')

  const matchedGuidance =
    typeof matched?.guidance === 'function'
      ? matched.guidance(platform)
      : matched?.guidance
  const baseGuidance =
    matchedGuidance ??
    (effectiveOutput
      ? 'Use the diagnostic output to identify the failing layer before retrying. Avoid repeated near-identical commands unless the next command tests a specific hypothesis.'
      : noDiagnosticGuidance(command))
  const guidance = appendCommandContextGuidance(baseGuidance, command, platform)

  return [
    'Bash failure analysis:',
    `- Exit code: ${exitCode}`,
    // The execution directory is the most common silent failure cause for
    // "file not found"-class errors — state it so the model can spot a
    // wrong-directory run immediately instead of retrying blind.
    ...(ranIn ? [`- Ran in: ${ranIn}`] : []),
    `- Reason: ${reason}`,
    `- Next step: ${guidance}`,
  ].join('\n')
}

export function appendBashFailureGuidance(
  command: string,
  exitCode: number,
  output: string,
  ranIn?: string,
  platform: Platform = getPlatform(),
): string {
  if (output.includes('Bash failure analysis:')) return output
  const guidance = buildBashFailureGuidance(command, exitCode, output, ranIn, platform)
  return output.trim() ? `${output.trimEnd()}\n\n${guidance}` : guidance
}
