# Interactive terminal UI

Run `codeagent` in an interactive terminal to open the full-screen UI. A task on
startup, such as `codeagent "Fix the tests"`, starts immediately and leaves the
screen open for follow-up work. `--resume <id>` and `--attach <id>` restore the
session transcript and any pending approval.

The interface uses the same local supervisor as the SDK and IDE. Closing the
screen detaches the client; the supervisor owns the run. No extra dependencies
or model configuration changes are required.

## Views

- **Chat:** streamed responses, headings, code blocks, and compact tool activity.
- **Activity:** command output, tool results, errors, and full approval details.
- **Tasks:** objectives, dependencies, owners, acceptance criteria, and check validity.
- **Agents:** coordinator and delegated worker status.
- **Jobs:** session-owned background commands and their latest output, refreshed while the view is open.
- **Sessions:** saved sessions; select one with arrow keys and Enter.

The footer shows run status, input/output/cached token usage, and cost when known.
Long outputs are bounded on screen; full durable history remains in the session.
A session opened from history displays “session model” because the current
inspection protocol does not expose its model configuration.

## Keyboard controls

| Key | Action |
| --- | --- |
| Enter | Send a prompt or steering message during a run |
| Alt+Enter | Insert a newline |
| Tab / Shift+Tab | Next / previous view |
| PageUp / PageDown | Scroll output |
| Ctrl+End | Return to live output |
| Up / Down | Input history; select sessions when the input is empty |
| Left / Right, Home / End | Move within input |
| Ctrl+A / Ctrl+E | Start / end of input |
| Ctrl+U / Ctrl+W | Delete input prefix / previous word |
| Escape / Ctrl+C | Cancel an active run; Ctrl+C exits when idle |
| Ctrl+D | Detach without cancelling work |

Bracketed paste inserts multiline text without submitting it. Press Enter to
send. Input supports Unicode grapheme editing. Terminals must support ANSI
cursor positioning and the alternate screen; at least 30 columns × 18 rows are
required. Windows Terminal with PowerShell is a suitable terminal host.

Approval prompts identify the pending action. Type `y` to approve once; `n` or
an empty Enter denies. Switching sessions never approves a request. A draft is
saved while the approval editor is open. For long requests, read the full text
in Activity with PageUp before answering. An approval answered by another
client is removed on the next event; stale answers are rejected by the server.

## Commands

`/help`, `/new`, `/sessions`, `/resume <id>`, `/fork`, `/undo`, `/status`,
`/chat`, `/activity`, `/tasks`, `/agents`, `/jobs`, `/cancel`, `/pause`,
`/detach`, `/exit`.

Use launch flags/settings for provider, model, permissions, and sandbox changes.
The historical experimental UI's theme, Vim, and fuzzy-picker helpers are not
wired into this runtime screen.

## Scripts and plain terminals

`--ui legacy` selects the plain prompt. `--ui next` explicitly selects the rich
UI on a TTY. `--print`, JSON/stream-JSON output, redirected input/output,
`TERM=dumb`, and `--detach` retain the plain/headless path. `NO_COLOR` disables
color while preserving layout. The TUI restores terminal modes on normal exit,
Ctrl+D, and handled termination signals; an uncatchable process kill cannot
run cleanup (`reset` on Unix restores the terminal if needed).
