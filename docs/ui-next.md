# Full-screen terminal UI

Start an interactive session with `codeagent --ui=next` (or `npm run dev -- --ui=next`). The default remains `--ui=legacy`. Redirected input/output and `TERM=dumb` fall back to the legacy interface; one-shot prompts and JSON output keep their existing behavior.

The full-screen UI uses the same agent runner, permissions, checkpoints, provider configuration, and saved sessions as the legacy REPL. It owns the terminal's alternate screen and restores the previous raw-input state and cursor on exit. No additional runtime dependency is required.

## Working in the terminal

- The transcript shows assistant text, optional reasoning, tool progress, errors, and task completion. Streamed answers appear once. Tool cards retain the last six output lines; the transcript retains up to 400 entries, with 32,000 characters per entry.
- The status row shows permission mode, model, sandbox, elapsed time, queue length, tokens, and cost where terminal width permits. Costs depend on provider usage and available model pricing.
- Type and send another prompt while a task is running to queue it. Up to 20 prompts run sequentially. Cancellation clears the pending queue.
- Permission and plan dialogs take keyboard focus. Only a typed `y` approves; Enter, `n`, and Escape deny. Pasted text cannot approve a dialog. Use arrow keys to scroll long previews.
- Agent questions use the input area. Answer with Enter; the previous draft is restored afterward.
- Unicode graphemes, bracketed multiline paste, terminal resize, and `NO_COLOR` are supported. At least 24 columns and 10 rows are needed; 100 columns is recommended for the status row.

## Keyboard controls

| Key                               | Action                                                                              |
| --------------------------------- | ----------------------------------------------------------------------------------- |
| Enter                             | Send prompt, queue prompt, or answer an agent question                              |
| Alt+Enter / Ctrl+J                | Insert newline                                                                      |
| Shift+Enter                       | Insert newline when the terminal sends an extended key sequence                     |
| Left / Right / Backspace / Delete | Edit by Unicode grapheme                                                            |
| Up / Down                         | Browse prompt history for single-line input; move between lines for multiline input |
| Home / End, Ctrl+A / Ctrl+E       | Start / end of the current input line                                               |
| Ctrl+U                            | Clear input                                                                         |
| Tab                               | Complete an unambiguous slash command                                               |
| Shift+Tab                         | Cycle permission mode while idle; bypass requires confirmation                      |
| Page Up / Page Down               | Scroll transcript                                                                   |
| Ctrl+End                          | Follow newest output                                                                |
| Ctrl+O                            | Show / hide reasoning                                                               |
| Ctrl+T                            | Show / hide todo summary                                                            |
| Escape                            | Deny an open dialog, otherwise cancel the current operation                         |
| Ctrl+C                            | Cancel an operation; while idle, clear a draft or exit if empty                     |
| Ctrl+D                            | Exit with empty input                                                               |

Prompt history is in-memory for the current terminal session. Session conversation history is saved separately and restored on resume. Terminals that cannot distinguish Shift+Enter from Enter should use Alt+Enter or Ctrl+J.

## Commands

| Command                                    | Action                                                                                        |
| ------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `/help`                                    | Show controls and commands                                                                    |
| `/status`                                  | Show session, workspace, permission mode, and Git status                                      |
| `/model [name]`                            | Show or change the model for subsequent tasks                                                 |
| `/mode default\|acceptEdits\|plan\|bypass` | Change permissions                                                                            |
| `/plan`                                    | Enter planning mode                                                                           |
| `/diff`                                    | Show the current tracked Git diff                                                             |
| `/undo`                                    | Confirm and restore files to the checkpoint before the last turn; retain conversation history |
| `/sessions`                                | List saved sessions for this workspace                                                        |
| `/resume <session-id>`                     | Save the current session and resume another in the same workspace                             |
| `/new`                                     | Save the current session and start an empty conversation                                      |
| `/export [path]`                           | Export Markdown without overwriting an existing file                                          |
| `/cost`                                    | Show cumulative session token usage and cost                                                  |
| `/clear`                                   | Clear the visible transcript while retaining model context                                    |
| `/cancel`                                  | Interrupt the current task and discard queued prompts                                         |
| `/exit`, `/quit`                           | Cancel work, save the session, and restore the terminal                                       |

Commands that change session state must wait until the current operation finishes. `/cancel` and `/exit` remain available during work. Provider requests, tools, and hooks retain their existing cancellation behavior; shutdown waits for the current operation to settle.

## Scope

This UI remains opt-in while terminal compatibility is validated. The legacy interface has additional commands, including provider/key setup and advanced configuration. Configure providers with existing CLI options or environment variables before launching the full-screen UI.

Transcript text, including Markdown and diffs, is shown as plain text with terminal control sequences removed. Fuzzy pickers, file-reference completion, Vim editing, custom keybindings, and selectable themes are not connected to the full-screen UI. The older `next.ts` and `keybindings.ts` helpers remain available to other callers.
