# codeagent

CLI-first autonomous coding agent: natural-language task in, verified Git diff out. `v0.7.0` — live-verification slice: first measured baseline 29/36, SSE byte-decode + system-fold + no-action-nudge fixes (see `CHANGELOG.md`; clean re-run, CI run + publish remain).

```
task -> shadow checkpoint -> intent check (regex + fast-model second opinion) -> explore / research (subagent, ranked map, symbols, ripgrep, read)
     -> implement (multi-strategy patch, pre-flight checks) -> in-loop diagnostics (tsc + eslint, ruff/pyright, go vet, cargo check)
     -> verify (test / build / lint in Docker or local runner, spawn + background jobs) -> review (git status / diff) -> summary
```

---

## Highlights

- ⚡ **Resilient Multi-Strategy Patch Engine**: Never fails on whitespace or indentation mismatch. Progressively falls back from exact match to CRLF/LF normalization, dynamic indentation scaling, fuzzy sliding-window Dice matching, and unified diff hunks.
- ⏪ **Transactional Checkpoints & 1-Command Rollback**: Takes ephemeral Git shadow checkpoints before every task. Use `/undo` (or `/revert`) to restore modified and newly created files instantly.
- 🩺 **In-Loop Diagnostics (multi-language)**: TypeScript syntax + `tsc --noEmit` plus eslint, plus `ruff`/`pyright` (Python), `go vet` (Go), `cargo check` (Rust) — best-effort, 3–5s caps, actionable feedback in the loop.
- 🔭 **Symbol Outlines (8 families)**: `view_symbol_outline` for TS/JS, Python, Go, Rust, Java/Kotlin/C#/PHP/Ruby, C/C++ with line numbers, saving context tokens. Ranked repo-map focus (`rankedRepoMap`) narrows the one-shot context to the task query.
- 🖼️ **Vision input**: `@image.png` mentions load base64 blocks (5-file / 8 MB caps) into Responses `input_image` history for capable models.
- 🤖 **Subagents + parallel fan-out**: read-only `run_subagent` (`explore`/`plan`/`reviewer`/custom `.codeagent/agents/*.md` with `tools`/`model` enforcement) plus model-facing `run_subagents` (2–5 parallel, order-preserving).
- 🚀 **Streaming execution**: true SSE providers (Responses/Anthropic/Gemini) stream `text_delta`/`thinking_delta`/`usage` by default; `run_command` uses `spawn` (tree kill, timeout, `bash_output`/`kill_shell`, `tool_output_delta`); batching via `StreamingToolExecutor`.
- 🧩 **Extensible**: MCP (`mcp__server__tool`, `/mcp`, `codeagent mcp add/list/remove`, per-tool `MCP(server:tool` rules), custom commands (`.codeagent/commands/*.md` with `$ARGUMENTS`/`@file`/`!cmd`), hooks (`SessionStart/UserPromptSubmit/PreToolUse/PostToolUse/Stop/PreCompact`), skills (`SKILL.md` descriptions in context), plugins (`codeagent plugin install/list/remove`).
- 🖥️ **Two UIs**: legacy readline (default) + `--ui=next` streaming layer (markdown, diff preview, status line, fuzzy pickers, queue, themes, vim mode + `~/.codeagent/keybindings.json`). `Shift+Tab` cycles permission modes.

---

## Quick start

```bash
npm install
cp .env.example .env   # add OPENAI_API_KEY (not needed for local Ollama)
npm run build
npm link               # installs the global `codeagent` command
```

Run it **in any project** (repository root defaults to your current working directory; `.env` is loaded automatically):

```bash
cd my-app
codeagent                              # interactive mode (REPL)
codeagent "Fix the failing test."      # one-shot CLI mode
codeagent "Add pagination to GET /users." --model openai/gpt-oss-20b
```

### CLI Options

| Flag | Description | Default |
|---|---|---|
| `--repo <path>` | Repository root | Current working directory |
| `-m, --model <id>` | Model identifier (e.g. `openai/gpt-oss-20b`, `gemini-2.0-flash`, `claude-sonnet-4-5`) | Provider default (`gpt-5.6-luna`) |
| `-p, --provider <name>` | LLM backend: `openai` (Responses SSE) \\| `chat` (Completions) \\| `anthropic` \\| `gemini` | Auto-detected |
| `-e, --endpoint <url>` | Custom OpenAI-compatible base URL (implies `chat` provider) | From environment |
| `-i, --iterations <n>` | Maximum agent iterations per task (alias: `--max-iterations`) | `30` (or `$MAX_ITERATIONS`) |
| `-s, --sandbox <mode>` | Execution environment: `docker` or `local` (settings `sandbox.image/network/mounts` apply) | `local` |
| `-y, --auto` | Bypass permission prompts for this run (same as `--dangerously-skip-permissions`) | off (fail-closed) |
| `--allowedTools <rules>` | Comma-separated allow rules, e.g. `Bash(npm test:*),Edit(src/**)` | none |
| `--print` | Headless: run one task and print the result (stdin pipe supported) | off |
| `--output-format <fmt>` | `text` \\| `json` \\| `stream-json` (AgentEvents) | `text` |
| `--ui <mode>` | Terminal UI: `legacy` (default) or `next` (streaming) | `legacy` |
| `--acp` | Start the ACP stdio bridge (IDE integration) | off |
| `mcp <add\\|list\\|remove>` | Manage MCP servers | |
| `plugin <install\\|list\\|remove>` | Manage plugin bundles (`~/.codeagent/plugins`) | |
| `-r, --resume [id]` / `-c, --continue` | Resume latest session (or by session ID / list index) | |
| `--sessions` | List saved sessions for this repository and exit | |
| `-h, --help` | Display command-line help | |

---

## Interactive REPL

Type `codeagent` without a task to enter the interactive REPL.

```text
╭──────────────────────────────────────────────────────────────╮
  │ ▲ CODEAGENT v0.7.0   ● Ready                                  │
 │                                                               │
 │   Workspace:  /workspace/my-app (⎇ main)                      │
 │   Model:      gpt-5.6-luna                                    │
 │   Sandbox:    local (use /sandbox docker to isolate)          │
 ╰──────────────────────────────────────────────────────────────╯

Type your task, or "/help" for commands · Ctrl+C cancels
```

Keys: `Shift+Tab` cycles permission modes · `Ctrl+T` todos · `Ctrl+O` thinking · `Ctrl+R` history · `Esc` interrupts (double-Esc rewind) · `?` shortcuts.

### Slash Commands

#### Session & Checkpoints
- `/undo` (alias: `/revert`) — Revert code to the last checkpoint (code-only).
- `/rewind [n] [code|conversation|both]` — Restore an earlier turn (picker when bare; fail-closed headless).
- `/export [file]` — Export the session to Markdown.
- `/checkpoints` — List turn checkpoints + session turns.
- `/sessions` — List and interactively switch between saved sessions.
- `/session resume <n|id>` (alias: `/resume <n>`, `-c/--continue`) — Resume a past session by index or ID.
- `/session new [title]` (alias: `/new`) — Start a fresh session.
- `/session save [title]` — Rename or checkpoint the active session.
- `/session delete <n|id>` — Delete a saved session from disk.
- `/repo <path>` — Switch the workspace repository root without restarting.
- `/mcp` — List configured MCP servers + reachable `mcp__*` tools.

#### Sandbox & Execution
- `/sandbox [docker|local]` — Toggle command execution between containerized Docker isolation and local execution.
- `/iterations <n>` — Set maximum agent turn iterations for subsequent tasks.

#### Planning & Tasks
- `/plan [on|off]` — Toggle Dual-Phase Plan Mode (locks modifications for read-only exploration).
- `/todos`, `/tasks` — Display the live task list; `toggle` switches between expanded and compact footer views (or press `Ctrl+T`).
- `/worktree create <slug>` — Create and switch to an isolated Git worktree sandbox.
- `/worktree main` — Return to the main repository from a worktree.
- `/worktree status` — Show current workspace isolation state.

#### Model & Backend Configuration
- `/model <id>` — Switch LLM model on-the-fly (e.g. `/model openai/gpt-oss-20b`).
- `/provider <name>` — Switch backend: `openai` | `chat` | `anthropic` | `gemini`.
- `/endpoint <url>` — Set OpenAI-compatible base URL (switches to `chat` provider); pass `off` to reset.
- `/key <api-key>` — Save API key globally in `~/.codeagent/.env` (configure once, works across all repos; `0600`, keychain when available).
- `/key --local <api-key>` — Save API key to `<repo>/.env` (per-project override).
- `/mode [default|acceptEdits|plan|bypass|auto|manual|cycle]` — Permission mode (`Shift+Tab` cycles); `/auto` + `/manual` are shortcuts.

#### Context & Inspection
- `/thought [on|off]` (alias: `/t`, or press `Ctrl+O`) — Toggle display of LLM reasoning / thinking blocks.
- `/diff` — Display colorized Git diff of current uncommitted changes.
- `/compact [focus]` — Compact conversation memory (fast-model summary, heuristic fallback).
- `/cost` — Session input/output tokens + cost (price-known indicator).
- `/init` — Generate `AGENTS.md` (never overwrites); `# note` appends to the resolved memory file.
- `/status` — Provider/model/roles/session/modes; shows `fast`/`plan` roles when configured.
- `/clear` — Clear the screen and reset in-memory conversation history.
- `/help` — Display REPL command menu.
- `/exit` (alias: `/quit`) — Exit `codeagent`.

> **Configure Once:** Run `/key <api-key>` to persist your key to `~/.codeagent/.env`. Key prefixes are automatically detected: `gsk_` activates Groq, `AIza` activates Gemini, `sk-or-` activates OpenRouter. Global settings follow you to every folder. Precedence order: explicit CLI flags / env vars > `<project>/.env` > `~/.codeagent/.env`.

---

## Advanced Features

### 1. Resilient Multi-Strategy Patch Engine

The agent uses a 5-tier resilient patch pipeline (`src/tools/patch.ts`) to virtually eliminate LLM patch application failures:

1. **Exact Substring Match**: Verbatim replacement when the model output matches source lines exactly.
2. **CRLF / LF Normalization**: Automatically bridges differences between Windows (`\r\n`) and Linux / macOS (`\n`) line endings.
3. **Indentation-Tolerant Scaling**: Matches lines even when the LLM generates 2-space indentation for a 4-space or tabbed source file.
4. **Fuzzy Sliding-Window Matching**: Employs Dice bigram similarity coefficient (threshold ≥ 0.88) over candidate line windows to forgive minor comment, punctuation, or whitespace drift.
5. **Unified Diff Application**: Parses standard patch hunks (`@@ -start,len +start,len @@`) directly when models emit diff syntax.
6. **Pre-Flight Syntax Validation**: Rejects syntax-corrupting writes (such as broken JSON or unclosed JS/TS brackets) before writing to disk.

### 2. Transactional Shadow Checkpoints & `/undo`

Before executing any modifying task, `codeagent` captures a lightweight Git shadow commit (`src/agent/checkpoint.ts`, `src/tools/git.ts`) stored under:
```
refs/codeagent/checkpoints/<checkpoint-id>
```
- Completely isolated from working branches, stash, and standard commit history.
- Run `/undo` in the REPL at any time to immediately restore modified files to their previous state and cleanly remove newly created files.
- Inspect history with `/checkpoints`.

### 3. In-Loop Fast Compiler Diagnostics

When writing or editing TypeScript/JavaScript files (`.ts`, `.tsx`, `.js`, `.jsx`), `codeagent` hooks into the compiler (`src/agent/diagnostics.ts`):
- Runs in-memory syntactic verification via TypeScript AST.
- Executes fast project typechecks (`tsc --noEmit`) with a tight 3-second non-blocking ceiling.
- Automatically appends an `[IN-LOOP COMPILER DIAGNOSTIC]` block to the tool output on turn 1 if errors are introduced.
- Gives the LLM immediate feedback to fix type errors before declaring the task complete.

### 4. AST Symbol Outline Navigation

Instead of reading entire 2,000-line source files into the context window, the agent leverages `view_symbol_outline` (`src/tools/symbols.ts`):
- Parses high-level AST structure for **TypeScript**, **JavaScript**, and **Python**.
- Returns a concise map of exported classes, interfaces, types, enums, methods, and functions with exact line numbers.
- Reduces token consumption by up to 80% during the initial exploration phase.

### 5. Pluggable Docker Sandbox Execution

Terminal commands can be executed either directly on the local host or inside an isolated container sandbox (`src/tools/sandbox.ts`, `src/tools/runner.ts`):
- Uses Docker containerization (`node:20-slim` default, configurable via `SANDBOX_IMAGE`).
- Enforces strict resource constraints (2GB RAM limit, 2 CPU cores).
- Mounts the workspace repository with host UID/GID mapping for seamless file ownership.
- Features non-blocking daemon health checks with graceful, automatic fallback to local host execution if Docker is not running.
- Easily toggleable via the CLI flag `--sandbox docker` or REPL command `/sandbox docker`.

### 6. Explorer Subagent Delegation

When assigned open-ended architectural research or broad codebase investigations, the agent spawns an isolated Explorer Subagent (`src/agent/subagent.ts`):
- Operates inside an independent context window with read-only tools (`list_files`, `read_file`, `view_file`, `search`, `view_symbol_outline`).
- Returns a structured markdown summary containing key findings, file references, and recommended modifications.
- Governed by a strict **"Stop & Present"** completion directive that prevents the main agent from re-reading the explored files.

### 7. Parallel Tool Execution

The agent loop distinguishes between read-only and mutating tool calls:
- Consecutive read-only tools (`read_file`, `view_file`, `search`, `view_symbol_outline`, `list_files`) are batched and executed concurrently via `Promise.all()`.
- State-mutating tools (`write_file`, `edit_file`, `run_command`) remain strictly sequential to ensure determinism and transactional safety.

---

## Tool Registry

| Tool | Mode | Description |
|---|:---:|---|
| `list_files` | Read-only | Recursively walks the repository, automatically filtering ignored patterns (`.git`, `node_modules`, `dist`, etc.). |
| `read` | Read-only | Canonical reader (offset/limit); `read_file`/`view_file` are compat aliases. Records full-file hash for read-before-write. |
| `view_symbol_outline` | Read-only | 8-family outline (TS/JS, Python, Go, Rust, Java/Kotlin/C#/PHP/Ruby, C/C++). |
| `search` / `grep` / `glob` | Read-only | Ripgrep search (`query`, path/glob/case/context/modes) + glob (`**/*.ts`). |
| `run_subagent` / `run_subagents` | Read-only | Isolated research + bounded parallel fan-out (2–5, order-preserving). |
| `write_file` / `edit_file` / `multi_edit` | Mutating | Gated edits; uniqueness + `replace_all` + atomic multi-edit + single-candidate fuzzy preview. |
| `run_command` / `bash_output` / `kill_shell` | Mutating | `spawn` (tree kill, timeout, background jobs, streamed deltas). |
| `git_status` / `git_diff` / `git_log` | Read-only | Working-tree inspection + recent subjects. |
| `web_fetch` / `web_search` | Read-only | Untrusted-content banner; search needs `WEB_SEARCH_ENDPOINT`. |
| `ask_user_question` | Read-only | Clarifying question (assumption note headless). |
| `todo_write` / `enter_plan_mode` / `exit_plan_mode` | Planning | Todos + plan approval (accept/edit/reject). |
| `mcp__server__tool` | Gated | MCP tools (per-tool `MCP(server:tool)` rules, untrusted-output boundary). |

---

## Architecture

| Layer | Responsibility | Key Files |
|---|---|---|
| `agent/` | Core autonomous loop, planning, subagents & diagnostics | `agent.ts`, `checkpoint.ts`, `compactor.ts`, `context.ts`, `diagnostics.ts`, `intent.ts`, `prompt.ts`, `subagent.ts`, `types.ts` |
| `tools/` | Tool implementations, resilient patching & execution runners | `filesystem.ts`, `patch.ts`, `runner.ts`, `sandbox.ts`, `search.ts`, `symbols.ts`, `terminal.ts`, `git.ts`, `index.ts` |
| `llm/` | LLM client protocols, tool definitions & provider bridges | `client.ts`, `chatProvider.ts`, `provider.ts`, `tools.ts` |
| `repo/` | Workspace scanning, file indexing & ignore rules | `scanner.ts`, `ignore.ts` |
| `session/` | Multi-session persistence and conversation history | `index.ts`, `storage.ts` |
| `cli/` | Interactive REPL, formatted UI spinners, boxes & banners | `repl.ts`, `ui.ts`, `ui/` |

---

## Free LLM Providers

`codeagent` supports both native OpenAI endpoints and generic OpenAI-compatible APIs (`chat` completions):

### 1. Ollama — Fully Local, Free, No API Key
```bash
ollama pull qwen2.5-coder:7b
```
```env
OPENAI_BASE_URL=http://localhost:11434/v1
MODEL=qwen2.5-coder:7b
```

### 2. Groq — Ultra-Fast Free Tier
Sign up at [console.groq.com](https://console.groq.com) for a key:
```env
OPENAI_BASE_URL=https://api.groq.com/openai/v1
OPENAI_API_KEY=gsk_...
MODEL=openai/gpt-oss-20b
```

### 3. Google Gemini — Free Tier
Create a key in [Google AI Studio](https://aistudio.google.com/):
```env
OPENAI_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai/
OPENAI_API_KEY=AIza...
MODEL=gemini-2.0-flash
```

### 4. OpenRouter — Free Community Models
Sign up at [openrouter.ai](https://openrouter.ai):
```env
OPENAI_BASE_URL=https://openrouter.ai/api/v1
OPENAI_API_KEY=sk-or-...
MODEL=qwen/qwen3-coder:free
```

---

## Safety & Security

- **Fail-closed by default**: edits/reads/commands gate through `PermissionManager` (ask); headless runs without a handler deny unless rule-allowed or `--allowedTools`; blanket approval is `--dangerously-skip-permissions` only (`-y/--auto` alias).
- **Modes**: `default` (ask) · `acceptEdits` · `plan` (deny edits) · `bypass`; `Shift+Tab` or `/mode`; deny wins; "Always allow" stores the full command/rule.
- **Shell parsing**: every `&&/||/;/|/&` segment + `$(...)`/backticks must be allowed; quoted separators don't split; hard deny covers sudo/`rm -rf /`/mkfs/shutdown/reboot/halt/diskpart/`format X:`/fork bombs.
- **Egress confirm**: network commands (`ssh/scp/curl/wget/git push/npm publish/...`) confirm in default mode (exact session allows stay silent).
- **Path Escape Protection**: All file paths are strictly resolved via `resolveInsideRepo`, preventing `../` directory traversal; symlinks must resolve inside the repo; `.git/`, `.codeagent/`, shell rc files are protected.
- **Secret Shield**: Refuses access to `.env`, private keys (`*.pem`, `id_rsa`), AWS credentials, and sensitive configurations; audit args are redacted (`<repo>/.codeagent/audit.jsonl`).
- **Untrusted output**: `web_fetch`/MCP/tool results are labeled data-only, never instructions.
- **Docker isolation + persistent sessions**: per-project image, `network:false` → `--network=none`, mounts; per-session containers (`ensure/removePersistentContainer`).

---

## Verification & Testing

```bash
# Type-check TypeScript codebase
npm run typecheck

# Run the automated test suite (350 across 34 files)

npm test

# Smoke eval (36 tasks, schema-only); live baseline needs EVAL_LIVE=1 + endpoint
npm run eval
EVAL_LIVE=1 npm run eval:live            # full 36-task baseline → eval/results/live.json
EVAL_LIVE=1 EVAL_TASKS=bug-ts-off-by-one npm run eval:live   # single task
EVAL_LIVE=1 npm run eval:record -- mystream   # capture eval/fixtures/mystream.jsonl

# Build production bundle (tsc) or single-file bundle (esbuild)
npm run build
npm run bundle
```

CI (`.github/workflows/ci.yml`): ubuntu + windows + macos, Node 22 — `npm ci`, typecheck, test, eval smoke, bundle.

## Live baseline (measured, Qwen3.8-27B via OpenAI-compat endpoint)

| Metric | Measured | Note |
|---|---|---|
| Pass rate | **33/36 (91.7%)** | Clean single-window baseline in `eval/results/live.json` |
| Median turns / solved | 8 | Nudge adds ≤ 1 turn on text-only starts |
| Median TTFT | 3,673 ms | Reduced from 8,487 ms with optimized quoting & SSE stream decoding |
| Mean time / task | 64.7 s | Down from 157.6 s (2.4x speedup) |
| Cost | $0.0000 | Model has no price entry (conservative fallback) |
| Prompt | `codeagent-prompt/2.0` | Pinned in smoke/live results + fixtures |

Fails (3): `bug-ts-off-by-one`, `bug-ts-null`, `refactor-extract` (pure exact-string expect assertions). Timeouts: 0 · Rate limits: 0 · Provider errors: 0. Merged single-window baseline evidence in `eval/results/live.json`. Live fixtures: `eval/fixtures/live-probe.jsonl`, `fast-probe.jsonl`, `live-tools.jsonl`.

## Headless, SDK, integrations

- `codeagent --print "task"` (+ stdin pipe) · `--output-format text|json|stream-json` (AgentEvents) · exit codes 0 ok / 1 failure-stuck / 2 permission / 3 budget / 4 config.
- `query()` (`src/sdk/query.ts`, `docs/sdk.md`) — async-iterator SDK with the same streaming path.
- `--acp` ACP stdio bridge + `extensions/vscode/` extension-host scaffold (run-task/cancel over stdio); `action.yml` runnable GitHub Action (`docs/github-action.md`); `codeagent plugin install/list/remove` (`docs/plugins.md`).
- Docs: `docs/` (quick-start, permissions, MCP, commands, hooks, providers, troubleshooting, action, sdk, plugins, ui-next).

---

## License

MIT
