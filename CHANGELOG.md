# Changelog

All notable changes to CodeAgent. Format follows Keep a Changelog; versioning follows SemVer.

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
