# Quick start

```bash
npm ci
npm run typecheck
npm test
npm run eval   # smoke: 36 tasks, schema-valid
```

## Interactive

```bash
npx tsx src/index.ts
# or after build:
npm run build && node dist/index.js
```

Slash commands: `/help /status /sessions /resume /new /undo /rewind /export /checkpoints /repo /model /provider /endpoint /key /sandbox /mcp /iterations /diff /plan /todos /compact /cost /init /mode /auto /manual /clear /exit`.

- `# note` appends to the memory file (`AGENTS.md` else `CODEAGENT.md` else `CLAUDE.md` else new `AGENTS.md`).
- `/init` scaffolds `AGENTS.md` without overwriting.
- `Shift+Tab` (or `/mode`) cycles `default → acceptEdits → plan → bypass`.
- `--ui=next` opts into the streaming UI (`--ui=legacy` is default).

## Headless

```bash
codeagent --print "Fix the failing test" --output-format stream-json
echo "Summarize this repo" | codeagent --print
```

Exit codes: 0 ok · 1 failure/stuck · 2 permission denied · 3 budget exceeded · 4 bad flags.

## Providers

`--provider openai|chat|anthropic|gemini`, `-e` for OpenAI-compat endpoints (Ollama, Groq, OpenRouter). Keys via env, `~/.codeagent/.env` (0600), or OS keychain when `keytar` is installed.
