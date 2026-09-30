# Custom commands

Drop Markdown files in `.codeagent/commands/*.md` (project) or `~/.codeagent/commands/*.md` (global):

```md
---
description: Ship a reviewed PR
---
Open a PR for $ARGUMENTS. Include @src/index.ts context. Summarize !git status --short.
```

- `$ARGUMENTS` → slash args.
- `@path/to/file` → first 8k chars inlined (max 5).
- `!shell cmd` → stdout inlined (max 3, 10s each).
- Project files shadow global files of the same name.
