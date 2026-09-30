# Plugins

Plugin bundles live in `~/.codeagent/plugins/<name>` (git clones).

```bash
codeagent plugin list
codeagent plugin install <git-url> [name]
codeagent plugin remove <name>
```

- `installPlugin` does `git clone --depth 1 <url>` (60s timeout).
- Skills/commands/agents inside a plugin are picked up via the standard
  `.codeagent/{skills,commands,agents}` loaders when symlinked or copied.
- Best-effort only: install failures throw, listing an empty dir returns `[]`.
