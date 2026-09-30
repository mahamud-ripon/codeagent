# Permissions

Modes: `default` (ask edits + commands), `acceptEdits`, `plan` (deny edits), `bypass` (`--dangerously-skip-permissions` only). Cycle with `Shift+Tab` or `/mode`.

Rules live in `~/.codeagent/settings.json`, `<repo>/.codeagent/settings.json`, `<repo>/.codeagent/settings.local.json`:

```json
{
  "permissions": {
    "mode": "default",
    "allow": ["Read(**)", "Bash(npm test:*)", "Edit(src/**)"],
    "ask": ["Bash(git push:*)", "Bash(npm install:*)"],
    "deny": ["Read(.env*)", "Bash(sudo:*)"]
  }
}
```

- Later files replace `mode`; allow/ask/deny accumulate; deny wins.
- "Always allow" stores a full command (`allowCommand`), never a bare first token.
- Compound commands (`&& || ; | &`, `$(...)`, backticks) authorize every segment; quoted separators don't split.
- Hard deny: sudo, `rm -rf /`, mkfs/shutdown/reboot/halt/diskpart, `format X:`, fork bombs (unless bypass/autoApprove).
- Non-interactive runs fail closed: only rule-allowed or `--allowedTools` run.
- Edits/reads gated (`type: edit/read`); default manager asks.
- Network-egress (`ssh/scp/curl/wget/git push/npm publish/docker push`) confirms in default mode.
- Protected: `.git/`, `.codeagent/`, shell rc files; symlinks must resolve inside the repo.
- Audit: `<repo>/.codeagent/audit.jsonl` (redacted, best-effort).
