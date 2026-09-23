# codeagent

CLI-first autonomous coding agent: natural-language task in, verified Git diff out.

```
task -> shadow checkpoint -> intent check -> explore / research (subagent, AST symbols, ripgrep, read)
     -> implement (multi-strategy patch, pre-flight checks) -> in-loop compiler diagnostics (tsc)
     -> verify (test / build / lint in Docker or local runner) -> review (git status / diff) -> summary
```

---

## Highlights

- ⚡ **Resilient Multi-Strategy Patch Engine**: Never fails on whitespace or indentation mismatch. Progressively falls back from exact match to CRLF/LF normalization, dynamic indentation scaling, fuzzy sliding-window Dice matching, and unified diff hunks.
- ⏪ **Transactional Checkpoints & 1-Command Rollback**: Takes ephemeral Git shadow checkpoints before every task. Use `/undo` (or `/revert`) to restore modified and newly created files instantly.
- 🩺 **In-Loop Fast Compiler Diagnostics**: Automatically catches TypeScript syntax and compiler errors (`tsc --noEmit`) on turn 1 of code edits, injecting actionable feedback directly into the loop for instant self-healing.
- 🔭 **AST Symbol Outline Navigation**: Scans exported classes, interfaces, types, methods, and functions across TypeScript, JavaScript, and Python with line numbers (`view_symbol_outline`), saving context tokens.
- 🐳 **Pluggable Docker Sandbox**: Runs terminal commands inside an isolated Docker container (`node:20-slim`) with memory/CPU limits and automatic fallback to local host execution if Docker is offline. Switch seamlessly via `/sandbox [docker|local]`.
- 🤖 **Explorer Subagent Delegation**: Offloads open-ended codebase exploration and architecture research to an isolated, read-only subagent with "Stop & Present" directives to keep the main agent's context clean.
- 🚀 **Parallel Tool Execution**: Batches consecutive read-only tool calls and executes them concurrently with `Promise.all()`, while keeping state-mutating tools strictly sequential.

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
| `-m, --model <id>` | Model identifier (e.g. `openai/gpt-oss-20b`, `gemini-2.0-flash`) | Provider default |
| `-p, --provider <name>` | LLM backend: `openai` or `chat` | Auto-detected |
| `-e, --endpoint <url>` | Custom OpenAI-compatible base URL | From environment |
| `-i, --iterations <n>` | Maximum agent iterations per task | `25` |
| `-s, --sandbox <mode>` | Execution environment: `docker` or `local` | `local` |
| `-h, --help` | Display command-line help | |

---

## Interactive REPL

Type `codeagent` without a task to enter the interactive REPL.

```text
▲ codeagent v0.1.0
Repo:     /workspace/my-app
Provider: openai (https://api.openai.com/v1)
Model:    gpt-4o
Sandbox:  local (use /sandbox docker to isolate)

Type your task or /help for commands. Press Ctrl+C to cancel, Ctrl+D to exit.
```

### Slash Commands

#### Session & Checkpoints
- `/undo` (alias: `/revert`) — Revert all files modified in the last task run and delete newly created files.
- `/checkpoints` — List recorded shadow checkpoints for the current session.
- `/sessions` — List and interactively switch between saved sessions.
- `/session resume <n|id>` (alias: `/resume <n>`) — Resume a past session by index or ID.
- `/session new [title]` (alias: `/new`) — Start a fresh session.
- `/session save [title]` — Rename or checkpoint the active session.
- `/session delete <n|id>` — Delete a saved session from disk.
- `/repo <path>` — Switch the workspace repository root without restarting.

#### Sandbox & Execution
- `/sandbox [docker|local]` — Toggle command execution between containerized Docker isolation and local execution.
- `/iterations <n>` — Set maximum agent turn iterations for subsequent tasks.

#### Model & Backend Configuration
- `/model <id>` — Switch LLM model on-the-fly (e.g. `/model openai/gpt-oss-20b`).
- `/provider <name>` — Switch backend provider: `openai` (Responses API) or `chat` (Chat Completions).
- `/endpoint <url>` — Set OpenAI-compatible base URL (switches to `chat` provider); pass `off` to reset.
- `/key <api-key>` — Save API key globally in `~/.codeagent/.env` (configure once, works across all repos).
- `/key --local <api-key>` — Save API key to `<repo>/.env` (per-project override).

#### Context & Inspection
- `/thought [on|off]` (alias: `/t`, or press `Ctrl+T`) — Toggle display of LLM reasoning / thinking blocks.
- `/diff` — Display colorized Git diff of current uncommitted changes.
- `/compact` — Trigger tiered conversation memory compaction to trim token usage.
- `/status` — Display active repository, provider, model, sandbox mode, and session details.
- `/clear` — Clear the terminal screen and reset in-memory conversation history.
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
| `read_file` | Read-only | Safe file reader with traversal blocking, secret masking, and size capping. |
| `view_file` | Read-only | Reads file slices with line numbers (`start_line`, `end_line`) for precise targeted context. |
| `view_symbol_outline` | Read-only | Extracts an AST structural outline of classes, functions, and interfaces for TS/JS/Python files. |
| `search` | Read-only | Fast regex & text search across repository source code powered by `@vscode/ripgrep`. |
| `run_subagent` | Read-only | Spawns an isolated subagent to conduct multi-step codebase research without polluting context. |
| `write_file` | Mutating | Creates new files or overwrites existing ones with pre-flight syntax checks and parent directory creation. |
| `edit_file` | Mutating | Applies targeted code edits via the 5-strategy resilient patch engine. |
| `run_command` | Mutating | Runs shell commands with timeouts, output caps, destructive-command filtering, and optional Docker sandboxing. |
| `git_status` | Read-only | Inspects repository working tree status. |
| `git_diff` | Read-only | Inspects uncommitted changes across the repository. |

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

- **Path Escape Protection**: All file paths are strictly resolved via `resolveInsideRepo`, preventing `../` directory traversal.
- **Secret Shield**: Refuses access to `.env`, private keys (`*.pem`, `id_rsa`), AWS credentials, and sensitive configurations.
- **Destructive Command Blocker**: Blocks dangerous shell patterns (`sudo`, `rm -rf /`, `mkfs`, fork bombs, etc.).
- **Docker Container Isolation**: Restricts container execution with isolated volumes, 2GB memory ceilings, and 2-CPU limits.
- **Environment Isolation**: Local environment variables are never transmitted to LLM providers; only truncated command outputs are shared.

---

## Verification & Testing

```bash
# Type-check TypeScript codebase
npm run typecheck

# Run full automated test suite (17 test files, 116 tests)
npm test

# Build production bundle
npm run build
```

---

## License

MIT
