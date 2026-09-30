# Hooks

Settings `hooks` map hook names to shell commands receiving JSON on stdin:

```json
{
  "hooks": {
    "SessionStart": [{ "command": "./scripts/welcome.sh" }],
    "UserPromptSubmit": [{ "command": "./scripts/log-prompt.sh" }],
    "PreToolUse": [{ "matcher": "Edit|Write", "command": "npx prettier --check \"$FILE\"" }],
    "PostToolUse": [{ "command": "echo \"$TOOL done\"" }],
    "Stop": [{ "command": "./scripts/gate.sh" }],
    "PreCompact": [{ "command": "./scripts/snapshot.sh" }]
  }
}
```

- `matcher` is a regex (fallback: `a|b` substring) matched against the tool name.
- Hooks never block the run on failure; output is truncated.
- Built-in stop hooks (`stopHooks.ts`: open todos, plan mode, compiler errors) still gate finishing.
- User `Stop` hooks block finishing only when they print `BLOCK` (see cookbook below).

## Cookbook (all six hooks)

Payloads arrive as JSON on stdin: `{ hook, ...fields }`. Keep commands fast
(< 15 s default timeout, stdout truncated to 4 KB).

### SessionStart — runs once when the REPL starts

```json
{ "hooks": { "SessionStart": [{ "command": "./scripts/welcome.sh" }] } }
```

```bash
#!/usr/bin/env bash
# scripts/welcome.sh — print repo state into the session log, never fail the start.
git status --short --branch | head -20
exit 0
```

### UserPromptSubmit — runs on every user turn (REPL + headless)

```json
{ "hooks": { "UserPromptSubmit": [{ "command": "./scripts/log-prompt.sh" }] } }
```

```bash
#!/usr/bin/env bash
# scripts/log-prompt.sh — append the prompt for audit; stdout is advisory only.
node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const p=JSON.parse(s);require('fs').appendFileSync('.codeagent/prompts.log',p.prompt+'\n')}catch{}})"
exit 0
```

### PreToolUse — runs before a tool call (`matcher` filters tool names)

```json
{ "hooks": { "PreToolUse": [{ "matcher": "Edit|Write", "command": "npx prettier --check \"$FILE\"" }] } }
```

Use it for format/lint pre-checks. A failing pre-check does not block the tool
(the agent sees the output and can fix it) — hard gating stays in
`stopHooks.ts` and the permission layer.

### PostToolUse — runs after a tool call

```json
{ "hooks": { "PostToolUse": [{ "matcher": "Bash", "command": "./scripts/after-bash.sh" }] } }
```

```bash
#!/usr/bin/env bash
# scripts/after-bash.sh — e.g. re-run a fast typecheck after edits.
node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const p=JSON.parse(s);if(/\.ts$/.test(p.tool||''))console.log('ts file touched')})"
exit 0
```

### Stop — user gate on finishing (only `BLOCK` output blocks)

```json
{ "hooks": { "Stop": [{ "command": "./scripts/gate.sh" }] } }
```

```bash
#!/usr/bin/env bash
# scripts/gate.sh — print BLOCK to keep the agent running, else exit 0.
if npm test --silent 2>&1 | grep -q "failing"; then
  echo "BLOCK: tests are red — fix them before finishing."
fi
exit 0
```

### PreCompact — runs before conversation compaction

```json
{ "hooks": { "PreCompact": [{ "command": "./scripts/snapshot.sh" }] } }
```

```bash
#!/usr/bin/env bash
# scripts/snapshot.sh — stash anything the summary must not lose.
git stash push -m "pre-compact $(date -u +%FT%TZ)" --keep-index --include-untracked
exit 0
```
