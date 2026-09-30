# Hooks

Settings `hooks` map hook names to shell commands receiving JSON on stdin:

```json
{
  "hooks": {
    "PreToolUse": [{ "matcher": "Edit|Write", "command": "npx prettier --check \"$FILE\"" }],
    "PostToolUse": [{ "command": "echo \"$TOOL done\"" }],
    "Stop": [{ "command": "./scripts/gate.sh" }],
    "SessionStart": [{ "command": "./scripts/welcome.sh" }],
    "PreCompact": [{ "command": "./scripts/snapshot.sh" }]
  }
}
```

- `matcher` is a regex (fallback: `a|b` substring) matched against the tool name.
- Hooks never block the run on failure; output is truncated.
- Built-in stop hooks (`stopHooks.ts`: open todos, plan mode, compiler errors) still gate finishing.
