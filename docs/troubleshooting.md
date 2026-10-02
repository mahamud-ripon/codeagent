# Troubleshooting

- `LLM authentication failed`: key must match endpoint (e.g. `gsk_` → Groq endpoint + Groq model).
- `Rate limited`: agent backs off 10s→60s ×5; switch to a roomier model or wait.
- `Request too large / 413`: context auto-compacts aggressively; `/compact [focus]` manually.
- `User denied ...`: approve, add an allow rule, or run with `--allowedTools`; non-TTY fails closed.
- `Stuck`: six identical calls or no-progress (4 failures / 8+ calls no durable effect) hands back with what was tried — resume with a different approach.
- `Blocked potentially destructive command`: hard-deny list; use bypass only unattended.
- `Docker daemon is not running`: requested Docker execution stops. Start a usable Docker daemon or explicitly select local mode.
- `Session "..." not found`: `--sessions` to list; legacy JSON migrates to JSONL on load.
- `MCP server unreachable`: skipped, never fatal; `codeagent mcp list` to inspect.
- Exit codes: 0 ok · 1 failure/stuck · 2 permission · 3 budget · 4 flags.
