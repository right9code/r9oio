export const PTY_TOOL_NAME = 'Pty'

export const DESCRIPTION =
  'Run a command inside a real pseudoterminal (PTY) for TUIs, REPLs, password prompts, and other interactive shells. Captures output until the command exits or the timeout fires.'

export const PTY_TOOL_PROMPT = `Run a command inside a pseudoterminal (PTY). Use this when a command requires a real TTY — e.g. full-screen TUIs (top, htop, vim opened non-interactively for one-shot ops), REPLs, interactive installers, or programs that detect "is a tty" and change behavior.

When NOT to use this:
- Plain non-interactive commands. Use Bash (or PowerShell on Windows) instead — those are faster and more featureful.
- Long-running daemons / dev servers. The PTY waits for the shell to exit; daemons never exit on their own. Use BashTool's background mode instead.

Inputs:
- \`command\` (required): the command to run. Sent to a fresh shell inside the PTY, followed by an automatic \`exit\` so the shell terminates after the command.
- \`cwd\` (optional): working directory for the PTY. Defaults to the current process cwd.
- \`timeoutMs\` (optional): kill the PTY after this many ms. Default 30000, max 600000.
- \`cols\` / \`rows\` (optional): terminal size. Defaults 120x30. Affects how TUIs lay out their output.

Output:
- The captured terminal output (includes ANSI control codes — they render visibly in transcript).
- exitCode, durationMs, plus flags for timedOut / truncated when relevant.

Notes:
- Output is capped at 1 MiB. Beyond that, further output is dropped (output text is marked truncated).
- ANSI escape sequences are kept verbatim — they're informative for the model when interpreting TUI state.
- If node-pty is not installed in this build, the tool returns an error message; install or rebuild with the native module to enable.`
