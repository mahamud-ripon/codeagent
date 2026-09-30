# `--ui=next` + keybindings

`--ui legacy|next` (default `legacy`). `next` streams `AgentEvent`s through
`src/tui/next.ts` (markdown, tool cards, diff preview, status line, fuzzy
pickers, message queue, themes) while the legacy reporter stays in sync via
`createReporterAdapter` (ARCH-1). The readline REPL is still the default UI
until `next` reaches parity.

- Status: `renderStatusLine({ model, branch, dirty, contextPct, costUsd, mode, sandbox })` (80-col safe, `NO_COLOR` honored).
- Themes: `dark|light|colorblind` via `themePalette`.
- Queue: `MessageQueue` holds typed messages while the agent runs.
- Pickers: `fuzzyFilter` backs sessions/models/checkpoints.
- Input: `isMultilineSubmit` + `autocompleteKindFor` (`/` commands, `@` files, `!` shell, `#` memory).

Vim mode + keybindings file (`src/tui/keybindings.ts`):

- File: `~/.codeagent/keybindings.json` — `{ "vim": true, "bindings": { ... } }`.
- Env override: `CODEAGENT_VIM=1|0`.
- `vimNextState("insert", "\x1b") → "normal"`; `i/a` back to `insert`.
- `Shift+Tab` cycles permission modes in the REPL (`default → acceptEdits → plan → bypass`); `Ctrl+R` searches history; `Ctrl+T` toggles todos; `Ctrl+O` expands thinking.
