# Changelog

All notable changes to CodeAgent. Format follows Keep a Changelog; versioning follows SemVer.

## [0.7.0] — 2026-09-30 (live-verification slice: first measured baseline + streaming/loop fixes)

First endpoint-backed slice. Three live-found bugs fixed (all with regression tests); first 36-task live baseline recorded; usage accounting corrected for future runs.

### Live-found fixes (all reproduced against real endpoints, then unit-locked)
- **SSE byte decode (ML-1, all streaming backends).** `parseSseStream` (Anthropic/Gemini/Responses) and `parseChatSse` (chat/compat) took the `Symbol.asyncIterator` branch on Node 22 fetch bodies and applied `String()` to `Uint8Array` chunks, yielding `"104,101,..."` and a **silent empty stream** — every live SSE run returned zero events. Both parsers now `TextDecoder`-decode byte chunks. Live `eval:record` went from 0 to real events on two endpoints. Tests: byte-chunk SSE cases in `chatStreaming.test.ts` + `providerContract.test.ts`.
- **Single-system fold (ML-1/ML-9, chat/Anthropic/Gemini).** Bisect proved a second `system` message (repo context) makes Qwen-via-proxy return an empty stream, while native Anthropic/Gemini translators silently **dropped** history systems (repo context never reached the model). New `extractHistorySystems` folds history systems into the one provider system string in all three adapters (chat request, Anthropic `system`, Gemini `system_instruction`); the one-shot chat Responder shares the fold. Order (head, request, history) preserved.
- **`delta.reasoning` thinking (ML-1).** The fast proxy streams thinking as `delta.reasoning`, not `reasoning_content`; `chatChunkToEvents` dropped it. Now folds to `thinking_delta` (matches `extractThinking`).
- **Small-model boundary (ML-4).** `/7b/i`-style patterns matched `27B` (`Qwen3.8-27B` ran one-tool-per-turn). Size suffixes now need a digit boundary; `Qwen3.8-27B` → full mode, `7b`/`8b` models unchanged.
- **No-action nudge (loop robustness).** Text-only turns with zero tool calls and zero modifications ended the run as "completed successfully" (observed live: 1-turn no-op summaries). The loop now asks once for inspection (bounded: one nudge, never on the last iteration; skipped after any tool call, modification, or todo). Greetings (conversational bypass) untouched. Two existing tests updated to the new contract (`usage` accounting isolated with `maxIterations: 1`; length-recovery expects the nudge turn).
- **Live usage accounting (QA-1).** `eval/live.ts` summed per-event `usage`, but the proxy emits duplicate identical usage chunks per turn (verified: `{3851,45}` twice). Per-turn usage is now last-wins.

### Live baseline (QA-1, first measured numbers — Qwen3.8-27B via OpenAI-compat proxy)
- **29/36 passed (80.6%)**, median 7 turns, median TTFT 8,487 ms, mean 157.6 s/task (median task time 180.0 s = the 3-min harness cap binds on this endpoint), cost $0.0000 (model has no price entry — conservative fallback, by design), prompt `codeagent-prompt/2.0`. Per-chunk evidence in `eval/results/live-fast1..12.json` + `fast1..12.log` (12 chunks x 3 tasks; chunk files for rounds re-run later were overwritten — see caveats).
- Fails (7): `bug-ts-off-by-one`, `bug-ts-null`, `refactor-extract`, `bug-off-by-slice`, `feat-py-class`, `bug-compare`, `feat-join`.
- Caveats (honest): (1) token totals in the first-round chunks are ~2x inflated (summed before the last-wins fix; fixed for future runs); (2) a second endpoint (free-tier proxy) showed 5/6 on the same harness but was too slow (~40 s/turn, cap-bound) for a full run; (3) late in the session the fast endpoint degraded sharply (86 s TTFT, instant empty-ish replies, 0/3 re-runs on previously 3/3 chunks — fragment kept as `eval/results/live-degraded-fragment.json`), so no merged `eval/results/live.json` is claimed yet: a clean 12-chunk re-run with corrected accounting is pending a healthy window.
- Live fixtures (QA-4): `eval/fixtures/live-probe.jsonl` (slow endpoint, tools off), `fast-probe.jsonl` (fast endpoint, tools off, with usage), `live-tools.jsonl` (tools on: thinking + tool_call folding without `finish_reason`, which the loop tolerates by design).

Suite total is now 350 across 34 files. Still open (needs keys/infra, unchanged): green GitHub CI run, npm publish (incl. `@codeagent/core`), published-install verification, keyed Action run, Docker-daemon test, 3-real-server MCP verification, live red-team, OS-keychain write path.

## [0.6.0] — 2026-09-30 (offline remaining slice: help, manifest, baseline, hooks, fixtures)

Closes the PRD §1.1 code-actionable remainder found on re-audit (tests green; live numbers, CI run, publish, Docker daemon still need their environments):

### Fixed
- `--provider` help line listed only `openai`/`chat` while the parser (and README) accepts `openai|chat|anthropic|gemini`; the help line now names all four, with `parseArgs` coverage for `anthropic`/`gemini`.
- `extensions/vscode/package.json` registered only `codeagent.runTask` while `extension.js` also handles `codeagent.cancelTask`; the manifest now contributes both commands plus both activation events.

### Evals and docs (QA-1/F-8, EX-3, QA-4)
- `eval/run.ts` now pins `PROMPT_VERSION` in the human-readable `eval/BASELINE.md` too (it was already in `smoke.json`/`live.json`/fixtures), so a prompt change without a fresh live baseline is visible without opening JSON.
- `docs/hooks.md` is now a six-hook cookbook (SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop with `BLOCK`, PreCompact) with copy-paste settings + scripts; hook behaviour itself is unchanged.
- `eval/fixtures/README.md` documents the live-recording contract (`EVAL_LIVE=1 npm run eval:record -- <name>`, `{meta}` + per-event JSONL) and that synthetic replay in `tests/providerContract.test.ts` stays the CI gate until fixtures exist.

### Tests
- `tests/offlineGaps.test.ts` (4 cases): four-provider parsing, help-line naming, VS Code manifest commands/activation/main, `PROMPT_VERSION` pinning + fixtures README presence. Suite total is now 341 across 34 files.

Still open (needs keys/infra, unchanged): live eval numbers, live-recorded fixtures, green GitHub CI run, npm publish (incl. `@codeagent/core`), published-install verification, keyed Action run, Docker-daemon test (no Docker in this environment), 3-real-server MCP verification, live red-team.

## [0.5.0] — 2026-09-30 (offline verification layer: MCP, secrets, red-team, cache accounting)

Closes the next PRD §1.1 code-actionable remainder without needing keys/infra (tests green; live numbers, CI run, publish, Docker daemon still need their environments):

### Safety verification (SF-6, ML-9)
- Cache-hit accounting (code half of ML-9): the agent loop accumulates `cachedInput` into run usage (Anthropic `cache_read_input_tokens`, Gemini cached content, Responses cached tokens, chat `cached_tokens` already flowed per-turn); `/cost` shows a "Cached input" line with its share of input; headless JSON usage carries `cachedInput`. Live values still need metered traffic.
- Offline red-team gates (`tests/redteam.test.ts`, 8 cases): `web_fetch` banners a payload-carrying page with the label preceding the payload; the system prompt + web tool descriptions frame results as untrusted; egress hidden behind `&&` / `$(…)` / `;` is detected while benign chains stay quiet.

### Extensibility and secrets (EX-1, ML-7)
- MCP round-trips offline (`tests/mcpRoundtrip.test.ts`, 4 cases): stdio list/call against a fixture server, HTTP list/call against a local endpoint, `mcp__*` dispatch wrapping fixture output in the untrusted-data boundary (label precedes payload), HTTP 500s surfacing on tool calls. The 3-real-server run stays open.
- Secret-store paths (`tests/keychain.test.ts`, 8 cases): 0600-file write/read round-trip incl. quote stripping and sibling-key preservation, home-scoped resolution that never touches the real HOME, env-wins ordering, POSIX 0600 mode, and safe keytar-absent degradation.

### Usage accounting (`tests/usage.test.ts`, 2 cases)
- `cachedInput` accumulates across model calls and defaults to zero when providers omit it.

### Release (REL-1)
- `npm pack --dry-run` verified: `codeagent-0.5.0.tgz` packs `dist/` + `docs/` + README/LICENSE/CHANGELOG (192 files). Actual publish still needs an npm token.

Suite total is now 337 across 33 files. Still open (needs keys/infra, unchanged): live eval numbers, live-recorded fixtures, green GitHub CI run, npm publish (incl. `@codeagent/core`), published-install verification, keyed Action run, Docker-daemon test (no Docker in this environment), 3-real-server MCP verification, live red-team.

## [0.4.0] — 2026-09-30 (remaining code gaps: chat streaming, live runners, VS Code scaffold)

Closes the PRD §1.1 code-actionable remainder (tests green; live numbers, CI run, and publish still need keys/infra):

### Provider and streaming (ML-1, F-1)
- Native Chat Completions SSE provider (`createChatStreamProvider`): `POST {baseURL}/chat/completions` with `stream: true`, local SSE parser (no import cycle with anthropic/gemini), 401s surface with status. `createStreamingProvider` no longer returns an empty stub for `openai-chat`, and `createProviderFromEnv` returns a `providerInstance` for chat/compat too — every backend streams by default (Ollama, Groq, OpenRouter…).
- First-token timing helper (`withFirstTokenTiming` in `stream.ts`): ms from stream start to the first text/thinking/tool event; the callback can never break the stream.

### Evals (QA-1, QA-4, F-8, F-1)
- `eval/live.ts` is a real runner: each task from `eval/tasks.json` executes in a throwaway tmp repo via `query()` (auto-approve, 15 iterations, 3 min cap), scores `ok` when `expect` appears in the final message or worktree, and reports turns/tokens/cost/seconds plus per-task TTFT. `EVAL_TASKS=id,…` / `EVAL_LIMIT=n` select tasks. Still exits 2 without an endpoint — no fake numbers.
- `eval/record.ts` records a real one-turn provider stream to `eval/fixtures/<name>.jsonl` (`{meta}` + one object per `ProviderEvent`) for contract replay.
- Prompt-regression gate (code half): `PROMPT_VERSION` is pinned in `eval/results/smoke.json`, `eval/results/live.json`, and every recorded fixture, so a prompt change without a fresh baseline is visible.

### Integrations and release (HL-5, REL-1)
- VS Code bridge scaffold in `extensions/vscode/` (dependency-free `extension.js`: spawns `codeagent --acp`, `runTask`/`cancelTask` commands, `agent/event` stream to the output channel).
- CI also runs `npm run bundle`, so the esbuild single-file bundle is verified on all three OSes.

### Tests
- `tests/chatStreaming.test.ts` (8 cases): SSE parsing incl. `[DONE]`/truncated frames, `stream:true` request shape + auth, tool-call folding, factory + chat-branch `providerInstance`, timing helper, TTFT/version scoring. Suite total is now 315 across 29 files.

Still open (needs keys/infra, unchanged): live eval numbers, live-recorded fixtures, green GitHub CI run, npm publish (incl. `@codeagent/core`), published-install verification, keyed Action run, Docker-daemon test, 3-real-server MCP verification, red-team eval.

## [0.3.0] — 2026-09-30 (wiring slice: default streaming + remaining dispatch)

Closes the §1.1 Partial wiring gaps as code (tests green, no live numbers yet):

### Provider and streaming (ML-1/ML-7/ML-9, AG-2)
- Default streaming: `createProviderFromEnv` returns `providerInstance` + versioned `systemPrompt` for Responses/Anthropic/Gemini; REPL/one-shot/SDK inject it so default runs stream deltas (chat/compat keeps the assembled responder).
- Versioned family prompt by default (`systemPromptForModel` → `buildSystemPrompt`); intent uses the fast-model second opinion when a summarizer is present.
- Keychain/file keys at runtime only (`resolveSecretSync` when `env === process.env`); explicit test envs stay pure.
- Cache: Anthropic `cache_control` breakpoints + stable prefix order in all three SSE providers; chat/Anthropic/Gemini forward vision image blocks.

### Agent quality (ML-4/ML-5, AG-10/12/14/15/16, F-17)
- Small-model: one tool per turn + JSON repair + `filterToolsForSmallModel` reference; plan-role responder while plan mode is active.
- Diagnostics beyond `tsc`: eslint, ruff/pyright, `go vet`, `cargo check` (stop hooks inherit them).
- Subagents: def `tools`/`model` enforced, provider overrides carry def models, model-facing `run_subagents` parallel tool.
- `run_command` foreground via `spawn` (tree kill, timeout, `tool_output_delta`); batching consolidated on `StreamingToolExecutor.partitionBatches`.
- Images: `@*.png|jpg|jpeg|gif|webp` load to Responses `input_text`/`input_image` history items.
- Context: ranked top-30 focus + skill descriptions in `buildInitialContext`.
- Hooks: PreCompact/UserPromptSubmit/Stop(user BLOCK)/SessionStart firing; Pre/Post preserved.

### Safety, TUI, sessions (SF-1/6/7, F-12/13, SS)
- `Shift+Tab` (`\x1b[Z`) cycles modes; `/mode` covers default/acceptEdits/plan/bypass + auto/manual; status line after switching; `Ctrl+R` history search.
- MCP per-tool `checkMcp` (`MCP(server:tool)` rules) + untrusted-output boundary in dispatch.
- Sandbox settings (`mode/image/network/mounts`) + persistent-container ensure/remove in REPL lifecycle.
- `--ui=next` renders via `renderNextEvent` + reporter adapter; `tui/keybindings.ts` (vim + `~/.codeagent/keybindings.json`).
- `repl.ts` imports `commandRegistry`/`sessionController`/`inputHandler`/`next`/`reporterAdapter`; `/mcp` lists servers/tools; unknown `/cmd` falls through to `.codeagent/commands/*.md` (`$ARGUMENTS`, `@file`, `!cmd`).

### Extensibility, headless, release (EX-1..5, HL-4/5, REL-1/2, QA)
- MCP `mcp__*` dispatch (stdio/HTTP, offline-safe); `codeagent plugin <install|list|remove>`; `query()` uses provider/roles/hooks/streaming.
- `action.yml` runnable GitHub Action (`--print` + `--output-format`); `eval/live.ts` + `eval/record.ts` (`eval:live`, `eval:record`); `esbuild` bundle (`npm run bundle`); package `files/license/repository`; docs `sdk.md`/`plugins.md`/`ui-next.md`.
- Still open: live eval numbers (needs endpoint), live-recorded fixtures, green GitHub CI run, npm publish, VS Code extension (ACP `--acp` is the bridge).

## [0.2.0] — 2026-09-30 (fourth slice: remaining PRD systems)

Closes the remainder of PRD v2 Phases 1, 3 (eval lift except live numbers), 4, 5, and 6 in code:

### Provider and streaming (ML-1)
- True streaming `Provider` adapters: native Anthropic Messages (`src/llm/anthropic.ts`), native Gemini generateContent (`src/llm/gemini.ts`), OpenAI Responses SSE (`src/llm/responsesStream.ts`), shared SSE parser, factory (`src/llm/streamingProvider.ts`).
- `Agent` accepts `providerInstance` and emits incremental `text_delta` / `thinking_delta` / `usage` via `collectStreamingWithEmit`; Responder stays the fallback.
- `createReporterAdapter` translates `AgentEvent` → legacy `AgentReporter` (ARCH-1).
- `--provider anthropic|gemini` selection; `--ui legacy|next` flag.

### Agent quality
- Modular versioned prompt (`promptSections.ts`, `PROMPT_VERSION`), family routing, fast-model intent second opinion (`intentModel.ts`).
- Small-model mode (`smallModel.ts`), per-tool plan-role routing (`modelRouting.ts`), OS keychain + 0600 fallback (`keychain.ts`), prompt-caching breakpoints + stable prefix order (`cache.ts`).
- Extended diagnostics + verify-command detection (`verify.ts`: eslint, ruff/pyright, go vet, cargo).
- User-defined subagents + reviewer + bounded parallel runs (`subagentsRegistry.ts`, `subagent.ts`).
- `spawn` runner with background jobs, `bash_output` / `kill_shell`, process-tree kill (`tools/process.ts`).
- Image `@mention` blocks (`agent/images.ts`), ranked repo map (`repo/rankedMap.ts`), multi-language symbol outline (TS/JS, Python, Go, Rust, Java/Kotlin/C#/PHP/Ruby, C/C++).

### Safety and sessions
- `Shift+Tab` mode cycle (`cyclePermissionMode`, `PermissionManager.cycleMode/setMode`).
- Network-egress confirm in default mode (`isNetworkEgressCommand`).
- Persistent per-session Docker containers, network-off, per-project image/mounts (`sandbox.ts`).

### TUI (`--ui=next`, no new deps)
- Streaming markdown, diff preview in permission prompt, status line, fuzzy pickers, queued messages, themes (dark/light/color-blind, `NO_COLOR`, 80-col safe), multiline + autocomplete kinds, Esc-interrupt preserved (`tui/next.ts`).
- F-13 split helpers: `commandRegistry.ts`, `sessionController.ts`, `inputHandler.ts` (repl.ts stays runtime).

### Extensibility
- MCP client stdio + streamable HTTP, `codeagent mcp add/list/remove`, `mcp__server__tool` naming, `/mcp` surface (`mcp/`).
- Custom slash commands with `$ARGUMENTS`, `@file`, `!cmd` (`cli/commands.ts`).
- User hooks SessionStart/UserPromptSubmit/PreToolUse/PostToolUse/Stop/PreCompact (`agent/hooks.ts`, wired Pre/Post).
- Skills (`agent/skills.ts`), plugin bundles (`extensions/plugins.ts`).

### Headless and integrations
- `@codeagent/core` SDK `query()` async iterator (`sdk/query.ts`).
- ACP stdio bridge (`integrations/acp.ts`), `--acp` flag; GitHub Action template (`docs/github-action.md`).

### Quality, evals, release
- Live eval scoring (`eval/score.ts` → `eval/results/live.json`); provider contract + fault-injection tests (`tests/remaining.test.ts`, `tests/providerContract.test.ts`).
- Docs: quick start, permissions, MCP, commands, hooks, providers, troubleshooting (`docs/`).
- Version 0.2.0.

## [0.1.0] — 2026-09-29/30 (slices 1–3)
- Phase 0 correctness/safety, P0 quality + safety slice, sessions slice (see PRD §1.1). Smoke harness 36 tasks; 266 tests across 25 files.
