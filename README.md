# cursor-clone (MVP)

CLI-first autonomous coding agent: natural-language task in, verified Git diff out.

```
task -> repo map -> explore (list/search/read) -> implement (edit/write)
     -> verify (run tests/build/lint) -> review (git status/diff) -> summary
```

## Quick start

```bash
npm install
cp .env.example .env   # add OPENAI_API_KEY (not needed for local Ollama)
npm run build
npm link               # installs the global `codeagent` command
```

Then run it **in any project** (repo defaults to your cwd, `.env` is
loaded from cwd):

```bash
cd my-app
codeagent                              # interactive mode (REPL)
codeagent "Fix the failing test."      # one-shot mode
codeagent "Add pagination to GET /users." --model openai/gpt-oss-20b
```

REPL slash commands: `/help` `/status` `/key` `/model <id>` `/provider openai|chat`
`/endpoint <url>|off` `/repo <path>` `/iterations <n>` `/diff` `/clear` `/exit`.
History persists in `~/.codeagent/history`. Ctrl+C cancels the running
task (press again when idle to quit).

**Configure once:** `/key <api-key>` saves to `~/.codeagent/.env` and
follows you to every directory. Key prefixes are recognized — a `gsk_`
key auto-selects the Groq endpoint, `AIza` Gemini, `sk-or-` OpenRouter.
`/model`, `/provider`, and `/endpoint` also persist globally, so backend
setup is one-time. Precedence is explicit env vars > `<project>/.env` >
`~/.codeagent/.env`, so a project-local `.env` (or `/key --local
<api-key>`) still overrides per project.

## How it works

| Layer | Knows | Files |
|---|---|---|
| `agent/` | WHAT to do (loop, phases, prompt) | `agent.ts`, `context.ts`, `prompt.ts`, `types.ts` |
| `tools/` | HOW to do it (fs, rg, shell, git) | `filesystem.ts`, `search.ts`, `terminal.ts`, `git.ts`, `index.ts` |
| `llm/` | HOW to talk to the model | `client.ts`, `tools.ts` |
| `repo/` | HOW the repo looks (map, ignores) | `scanner.ts`, `ignore.ts` |

The CLI (`src/index.ts`) is a thin wrapper around `Agent` so a VS Code
extension can reuse the same core later via an Agent Server.

## Tools

- `list_files` — repo walk skipping `.git node_modules dist build .next coverage`
- `read_file` — traversal-checked, secret-refusing, 50k-char capped
- `write_file` — creates parents, tracks modified files
- `edit_file` — exact single-match replacement, fails on 0 or N matches
- `search` — ripgrep via `@vscode/ripgrep` bundle (`RG_PATH` override supported)
- `run_command` — timeout (120s), output cap, destructive-command blocklist, structured exit codes. **DEV-ONLY — no sandbox.** Behind the `CommandRunner` interface so Docker/VM can replace it without touching agent code.
- `git_status` / `git_diff` — verification before finish. Never commits.

## Free LLM providers

The agent has two backends. `openai` (Responses API, default) has the most
reliable tool-calling on OpenAI models. `chat` speaks Chat Completions to
**any OpenAI-compatible endpoint** — this is the free-model route. Set
`OPENAI_BASE_URL` and it switches automatically (`LLM_PROVIDER=chat`
forces it). The CLI prints the active `Provider: openai-chat (...)` line.

**1. Ollama — fully local, free, no key**
```bash
ollama pull qwen2.5-coder:7b
```
```env
OPENAI_BASE_URL=http://localhost:11434/v1
MODEL=qwen2.5-coder:7b
```

**2. Groq — free tier, very fast (key from console.groq.com)**
```env
OPENAI_BASE_URL=https://api.groq.com/openai/v1
OPENAI_API_KEY=gsk_...
MODEL=openai/gpt-oss-20b
```
Model IDs churn — if you get a 404, list what your key can actually
see (key never printed, only sent to Groq):
```bash
node --input-type=module -e "import dotenv from 'dotenv'; dotenv.config(); const k = process.env.OPENAI_API_KEY; const r = await fetch('https://api.groq.com/openai/v1/models', { headers: { Authorization: 'Bearer ' + k } }); const j = await r.json(); console.log(j.data.map(m => m.id).sort().join('\n'));"
```

**3. Gemini — free tier (key from AI Studio)**
```env
OPENAI_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai/
OPENAI_API_KEY=AIza...
MODEL=gemini-2.0-flash
```

**4. OpenRouter — `:free` models (key from openrouter.ai)**
```env
OPENAI_BASE_URL=https://openrouter.ai/api/v1
OPENAI_API_KEY=sk-or-...
MODEL=qwen/qwen3-coder:free
```

Notes:
- Model IDs change — verify against the provider's current model list.
- Small/local models call tools less reliably. Prefer coder/instruct
  models ≥7B; the agent's repeat-detection and error feedback absorb
  most of the remaining flakiness, but expect more iterations than
  with a frontier model.
- Trade-off: the Responses path echoes native output items (reasoning,
  etc.) back to the model; the chat path translates history to
  system/user/assistant/tool messages each turn, so provider-specific
  extras are dropped.

## Safety

- All model paths go through `resolveInsideRepo` (no `../` escapes).
- `.env`, SSH keys, `*.pem`, `.aws/credentials` are refused.
- Env vars are never sent to the model; only truncated tool output is.
- Destructive shell patterns (`sudo`, `rm -rf /`, `mkfs`, fork bombs…) are blocked — shallow defense, not a sandbox.

## Verification

```bash
npm run typecheck
npm test
npm run build
```

First real test: point the agent at a repo with a failing test and watch
`list_files -> read -> edit -> run_command -> git_diff -> summary`.
