# oio Command Reference

`oio` (`r9`) provides interactive slash commands for multi-agent swarm coordination, model routing, session lifecycle, sandboxing, and project memory.

---

## 1. Multi-Agent & Swarm Orchestration

| Command | Usage | Description |
| :--- | :--- | :--- |
| **`/swarm`** | `/swarm [objective]` | Launch the **LEAD / EXEC** multi-agent swarm wizard. Decomposes tasks into `_TASKS.MD` and routes doubts to `_QUERIES.MD`. |
| **`/swarmmodels`** | `/swarmmodels` | Browse, inspect, and filter available models across all connected providers for swarm assignment. |
| **`/realping`** | `/realping [filter] [--concurrency N] [--sample]` | Live-sweep every catalog model with a 1-token ping and print only the models that actually answered correctly. Full sweep is the default; `--sample` probes a quick subset, `--concurrency` defaults to 40 (max 64). |
| **`/hold`** | `/hold` | Temporarily pause running EXEC agents in a swarm to inspect progress or steer direction. |
| **`/release`** | `/release` | Release the hold on EXEC agents and resume swarm task execution. |
| **`/steer`** | `/steer <guidance>` | Provide mid-flight instructions, architectural guidance, or answers directly to the LEAD agent. |
| **`/btw`** | `/btw <question>` | Ask a quick side question without interrupting or polluting the main task conversation. |
| **`/tasks`** | `/tasks` | Open the interactive background task and agent monitor dialog. |
| **`/agents`** | `/agents` | Configure custom agent personas and specific model overrides. |

---

## 2. Models, Routing & Reasoning

| Command | Usage | Description |
| :--- | :--- | :--- |
| **`/models`** | `/models [query]` | Interactive fuzzy model selector with latency sorting and starred favorites (`Ctrl+F`). |
| **`/model`** | `/model <provider:model>` | Directly set the active model without opening the picker. |
| **`/provider`** | `/provider` | Manage provider credentials and endpoints: Anthropic, OmniRoute, OpenAI, Antigravity, Mistral, Ollama, LM Studio, plus any custom OpenAI-compatible gateway you add yourself. |
| **`/lane`** | `/lane [status\|why\|enable\|disable]` | Inspect and control native lane routing policies across local and cloud providers. |
| **`/surf`** | `/surf [on\|off]` | Dynamic dual-model routing: automatically routes heavy reasoning to smart models and execution to fast models. |
| **`/thinking`** | `/thinking [on\|off]` | Toggle extended reasoning/thinking mode for supported models (Claude 3.7/Sonnet, Gemini 2.0 Flash Thinking). |
| **`/effort`** | `/effort [low\|medium\|high]` | Configure thinking effort budget for models with adjustable reasoning. |
| **`/vision-model`** | `/vision-model <model>` | Set a dedicated multimodal vision model for image and screenshot analysis. |
| **`/advisor`** | `/advisor [on\|off]` | Configure a second model to shadow and advise on high-risk command decisions. |
| **`/fallback`** | `/fallback [models...]` | Configure automatic fallback models when the primary provider returns 429 or quota limits. |

---

## 3. Session Lifecycle & Fork Tree

| Command | Usage | Description |
| :--- | :--- | :--- |
| **`/tree`** | `/tree` | Interactive TUI tree viewer showing session branches, parent-child forks, and checkpoints. |
| **`/clone`** | `/clone` | Duplicate the current session into a clean copy and immediately switch into it. |
| **`/branch`** | `/branch` | Fork the conversation at the current turn while leaving the parent branch intact. |
| **`/resume`** | `/resume [session-id]` | Pick up where you left off from a previous session or browse the recent session list. |
| **`/rename`** | `/rename [new-name]` | Set a friendly human-readable name for the active session (shows in `/tree` and `/resume`). |
| **`/compact`** | `/compact [instructions]` | Compact conversation history down to a concise summary to recover context window tokens. |
| **`/compact-settings`**| `/compact-settings` | Configure automatic context compaction thresholds and recent message preservation rules. |
| **`/clear`** | `/clear` | Wipe conversation history and reset context memory for a fresh start. |
| **`/rewind`** | `/rewind` | Revert conversation and modified files back to a prior turn or checkpoint. |
| **`/tag`** | `/tag <tag-name>` | Attach searchable tags to the active session for quick discovery in `/resume`. |
| **`/export`** | `/export [file]` | Export conversation transcript and code artifacts to markdown, JSON, or clipboard. |
| **`/import`** | `/import <file.jsonl>` | Import an external session `.jsonl` file and resume into it. |

---

## 4. Context, Memory & Project Knowledge

| Command | Usage | Description |
| :--- | :--- | :--- |
| **`/context`** | `/context` | Display an interactive colored grid showing exact token usage across system, tools, and messages. |
| **`/memory`** | `/memory` | Inspect and edit persistent agent memory files stored for the project. |
| **`/learned`** | `/learned` | Review and manage lessons and behavioral adjustments `oio` learned automatically. |
| **`/corrections`** | `/corrections` | Mine past user corrections from session logs and consolidate them into project rules (`CLAUDE.md`/`AGENTS.md`). |
| **`/pin`** | `/pin <instruction>` | Pin a persistent constraint or rule that gets automatically injected into every model turn. |
| **`/files`** | `/files` | List all files currently retained in the agent's active memory context. |
| **`/add-dir`** | `/add-dir <path>` | Add an additional directory outside the current workspace to tool access and search scopes. |
| **`/init`** | `/init` | Bootstrap project memory by generating a tailored `AGENTS.md` / `CLAUDE.md` guide. |

---

## 5. Modes, Permissions & Sandboxing

| Command | Usage | Description |
| :--- | :--- | :--- |
| **`/mode`** | `/mode [cheap\|normal]` | Toggle default operational profile (cost-conserving vs maximum capability). |
| **`/plan`** | `/plan` | Enter read-only architect mode: inspect code and draft implementation plans without modifying files. |
| **`/permissions`** | `/permissions` | Manage rule allowlists/denylists for Bash execution, file writes, and network calls. |
| **`/dangerously-skip-permissions`** | `/dangerously-skip-permissions` | Bypass all permission prompts for the current session (recommended only in isolated sandboxes). |
| **`/sandbox-toggle`** | `/sandbox-toggle` | Enable or disable Linux sandbox container isolation for Bash commands. |
| **`/overlay`** | `/overlay [on\|off\|status\|diff\|apply\|reject]` | Manage the OverlayFS copy-on-write workspace to stage edits safely before applying to disk. |
| **`/safetest`** | `/safetest <command>` | Run an untrusted script or test inside an ephemeral, disposable sandbox. |

---

## 6. Git, Code Review & GitHub

| Command | Usage | Description |
| :--- | :--- | :--- |
| **`/diff`** | `/diff` | Interactive view of working tree git changes and per-turn diffs since session start. |
| **`/commit`** | `/commit [message]` | Generate a structured git commit message based on staged changes and commit. |
| **`/commit-push-pr`**| `/commit-push-pr` | Full automated flow: stage changes, commit, push branch, and open a GitHub pull request. |
| **`/review`** | `/review [pr-url]` | Perform a thorough multi-file code review with suggestions and diff inspection. |
| **`/security-review`**| `/security-review` | Scan modified code for credentials, injection risks, and sandbox escape vectors. |
| **`/github`** | `/github <subcommand>` | Direct GitHub manager: manage issues, review PR comments, draft releases, and generate changelogs. |
| **`/pr-comments`** | `/pr-comments <pr-number>` | Fetch and address inline feedback comments from a GitHub pull request. |

---

## 7. Extensions, Tools & System Diagnostics

| Command | Usage | Description |
| :--- | :--- | :--- |
| **`/mcp`** | `/mcp` | Manage Model Context Protocol (MCP) server connections, tools, and resources. |
| **`/plugin`** | `/plugin [list\|install\|remove]` | Manage installed `oio` / Omarchy plugins and capabilities. |
| **`/reload-plugins`**| `/reload-plugins` | Hot-reload plugin code and definitions in the running session without restarting. |
| **`/skills`** | `/skills` | Browse, test, and view registered agent skills (`SKILL.md` definitions). |
| **`/tools`** | `/tools` | Interactively toggle built-in tools on/off (Bash, Edit, Write, WebSearch, Fetch). |
| **`/hooks`** | `/hooks` | Inspect active shell and event lifecycle hooks configured in `~/.config/oio/hooks/`. |
| **`/status`** | `/status` | Full environment diagnostic: version, provider endpoint health, active tools, and git status. |
| **`/doctor`** | `/doctor` | Self-diagnostic check to verify binaries, bun/node versions, and required permissions. |
| **`/statusline`** | `/statusline` | Configure the bottom TUI status line display (token counts, git branch, active model). |
| **`/theme`** | `/theme` | Switch TUI color themes (Omarchy Nord, Gruvbox, Tokyo Night, Monokai, etc.). |
| **`/color`** | `/color <ansi-color>` | Set a custom accent color for the input prompt border. |
| **`/keybindings`** | `/keybindings` | Open and edit keyboard shortcuts (`~/.config/oio/keybindings.json`). |
| **`/vim`** | `/vim` | Toggle Vim modal navigation keys (`hjkl`, insert/normal modes) in the prompt input. |
| **`/cost`** | `/cost` | Show total token consumption, estimated monetary cost, and turn durations. |
| **`/usage`** | `/usage` | Detailed breakdown of provider quota usage and account limits. |
| **`/stats`** | `/stats` | Long-term usage analytics across all historical sessions. |
| **`/report`** | `/report` | Format and export a clean markdown executive report of changes made in the session. |
| **`/version`** | `/version` | Display current running version and build commit hash. |

---

## 8. Communication & Mobile Bridges

| Command | Usage | Description |
| :--- | :--- | :--- |
| **`/whatsapp`** | `/whatsapp [login\|on\|off]` | Connect or toggle the WhatsApp companion bridge to chat with `oio` from your phone. |
| **`/remote`** | `/remote` | Generate a pairing QR code to view and drive the session remotely from mobile web. |
| **`/session`** | `/session` | View current remote session pairing URL and active connection state. |
| **`/ide`** | `/ide` | Inspect and configure active IDE companions (VS Code extension / Neovim plugin). |
| **`/desktop`** | `/desktop` | Hand off the current CLI session to the desktop GUI app. |
| **`/hey`** | `/hey` | Enter push-to-talk voice mode (hold Space to speak, release to submit prompt). |
| **`/bye`** | `/bye` | Exit voice mode and cancel any audio synthesis in progress. |
| **`/goal`** | `/goal <objective>` | Launch an autonomous loop that iterates continuously until a validation test passes. |
| **`/feedback`** | `/feedback <message>` | Submit bug reports or feedback to the `right9code/r9oio` repository. |
| **`/exit`** | `/exit` | Exit the `oio` session cleanly. |
