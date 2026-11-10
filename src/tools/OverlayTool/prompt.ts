export function getOverlayToolPrompt(): string {
  return `Inspect and manage the overlay sandbox. Only available while the user has the sandbox turned on (/overlay on).

- action "status": whether the sandbox is on and how many changes are pending.
- action "diff": the cumulative diff of every pending change (files added, deleted, modified).
- action "apply": write all pending changes into the real working tree and turn the sandbox off. Use when the user approves the changes.
- action "reject": throw away all pending changes. The real tree was never touched, so nothing is restored — the overlay is simply deleted.

The sandbox captures file edits made through tau's Write/Edit/NotebookEdit tools. Shell commands (Bash, PowerShell) are NOT captured — they still see and modify the real working tree directly. Do not assume /overlay diff reflects changes made by shell commands.`
}
