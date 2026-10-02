# Eval baseline — thin runtime, measured ablations (plan.md)

Scores on v1 and v2 are never graphed together. v1 is frozen history;
v2 is the only suite under development.

## advanced-v1 (frozen)

- File: `eval/tasks-advanced-v1.json` (byte-for-byte frozen, do not edit).
- SHA256: `d33c0264f3961d2028d092e207c9ed67fb6cf5b2b0c514bb219d6032870b06c9`
- Historical live run (`eval/results/live-advanced.json`, prompt `codeagent-prompt/2.1`):
  13/20 passed (65.0%), effective 72.2% (timeout + rate-limit excluded),
  median turns 15 (cap), mean 138.6 s, median TTFT 1.237 s, tokens/cost 0.
- 95% Wilson interval for 13/20 is about 43–82%. One seed cannot detect
  a change under about 20 points.
- v1 numbers stay computed with the old outcome enum (`TASK_PASS`,
  `TASK_FAIL`, `MODEL_TIMEOUT`, `MODEL_RATE_LIMIT`, `PROVIDER_ERROR`) so the
  historical file still loads. A v1 `TASK_FAIL` that was a wall-clock abort
  is not rewritten.

## advanced-v2 (corrected harness, current agent)

- File: `eval/tasks-advanced-v2.json` (only suite under development).
- Corrections vs v1 (harness-only, not agent):
  1. `adv-ts-shared-types`: verifier `require\(["']\.\/types\.js?["']\)`
     becomes `require\(["']\.\/types(\.js)?["']\)` (accepts `./types` and `./types.js`).
  2. `adv-py-shadow`: `expect: "jsonutil"` (a name the prompt never gives)
     becomes `"helper"`; the verify script (`SHADOW-OK`) is the real gate.
  3. `adv-py-config`: prompt now names `AppConfig`, `DbConfig`, `CacheConfig`
     with the fields the verifier constructs; verifier stays strict.
  4. `adv-ts-middleware`: prompt keeps 4-arg error handlers and states the
     contract visible in `server.js` (2-arg `fn(req,res)`, thrown error to
     error handler, 404 only when nothing wrote). Verifier registers both a
     4-arg `(err,req,res,next)` and a 3-arg `(err,req,res)` handler; both must
     produce 500 `"caught:boom"`. Normal path + bare 404 stay. No runtime
     rule names `next()`.
  5. `adv-go-pool`: prompt says keep `package main` and the existing `New`,
     `Submit`, `Shutdown` signatures (injected test stays `package main`).
- Primary budget: **600 s and 30 turns**. Secondary columns (same traces,
  not the score): `latency-constrained` (unfinished at 180 s),
  `turn-constrained` (unfinished at 15 turns). Turns-to-green is the
  efficiency metric (first green targeted check, not final stop).
- Baseline: `advanced-v2` at 3 seeds, Phase 2 flags off (corrected harness
  on current agent). Per-task table below; a suite percent on 2–5 movers is
  not interpretable. 3 seeds × 20 tasks are 20 identities, not 60 trials.
- Infra (`TIMEOUT`, `RATE_LIMIT`, `PROVIDER_FAILURE`) rerun once; model
  table uses the rerun. A 600 s / 30-turn `TIMEOUT` is still infra.
- Prompt: `codeagent-prompt/2.2` (evidence block only, no task sentences).

### v2 baseline (flags off, 3 seeds) — DONE 2026-10-02

Model `nvidia/nemotron-3-ultra-550b-a55b`, all flags off, 600 s / 30 turns.
Merged from `eval/results/seed{1,2,3}/live-advanced-v2-fast*.json` (21 chunk
files) + 60 per-turn JSONLs in `eval/results/advanced-v2/` (1,366 rows; 0 rows
missing `providerRetries`, 1 row missing `queueMs`, `reasoningTokens: null` on
100% of rows, `usageEstimated: true` on 10 rows from failed-call retry emits).
Full table: `eval/results/live-advanced-v2.json`.

**42/60 passed (70.0%)** — seeds 13/20, 14/20, 15/20. For reference the v1
single run was 13/20 (65%); the two numbers are NOT comparable (different
harness, budget, model). 3 seeds × 20 tasks are 20 identities, not 60 trials;
no suite-percent claim follows.

```
adv-ts-rename-chain      seed1 pass(30t)      seed2 pass(15t)      seed3 pass(18t)
adv-ts-import-cycle      seed1 pass(10t)      seed2 pass(7t)       seed3 pass(6t)
adv-ts-middleware        seed1 FAIL(18t)      seed2 FAIL(30t)      seed3 FAIL(30t)
adv-ts-emitter           seed1 pass(9t)       seed2 FAIL(30t)      seed3 FAIL(14t)
adv-ts-config-merge      seed1 pass(30t)      seed2 pass(30t)      seed3 pass(30t)
adv-ts-paginate          seed1 pass(30t)      seed2 pass(15t)      seed3 pass(30t)
adv-ts-extract-validate  seed1 pass(30t)      seed2 FAIL(30t)      seed3 FAIL(30t)
adv-ts-event-tests       seed1 FAIL(30t)      seed2 pass(7t)       seed3 pass(8t)
adv-ts-shared-types      seed1 FAIL(30t)      seed2 pass(17t)      seed3 pass(22t)
adv-py-retry             seed1 pass(19t)      seed2 pass(30t)      seed3 pass(14t)
adv-py-lru               seed1 pass(7t)       seed2 pass(6t)       seed3 pass(6t)
adv-py-csvstats          seed1 FAIL(23t)      seed2 pass(11t)      seed3 pass(13t)
adv-py-shadow            seed1 pass(23t)      seed2 pass(30t)      seed3 pass(7t)
adv-py-config            seed1 pass(30t)      seed2 pass(30t)      seed3 pass(30t)
adv-py-plugins           seed1 pass(30t)*     seed2 FAIL(30t)      seed3 pass(30t)
adv-py-migrate           seed1 pass(30t)      seed2 pass(30t)      seed3 pass(30t)
adv-go-pool              seed1 FAIL(30t)      seed2 FAIL(30t)      seed3 FAIL(26t)
adv-go-errwrap           seed1 pass(30t)      seed2 pass(30t)      seed3 pass(17t)
adv-go-rename            seed1 FAIL(30t)      seed2 pass(30t)      seed3 pass(19t)
adv-go-limiter           seed1 FAIL(9t)       seed2 FAIL(30t)      seed3 FAIL(30t)
(* py-plugins seed1 first attempt RATE_LIMIT auto-reran to PASS; model table uses the rerun.)
```

Stable pass 3/3 (10): rename-chain, import-cycle, config-merge, paginate,
py-retry, py-lru, py-shadow, py-config, py-migrate, go-errwrap. Stable fail 0/3
(3): middleware, go-pool, go-limiter. Split 2–1 (7): emitter, extract-validate,
event-tests, shared-types, csvstats, py-plugins, go-rename.

Harness fixes confirmed working: `adv-py-shadow` 3/3 (old `jsonutil` gate gone);
`adv-ts-shared-types` regex accepts `./types` (s1 FAIL is agent-broken factory,
"factory broken", not the regex — s2/s3 pass). Middleware 0/3 under the
dual-arity verifier is agent-side chain-breaking (s1: 200/hello), covered by the
general preserve-call-convention rule, no runtime special case.

Agent-side failure shapes (all under general rules): go-pool — unused var,
generic inference vs injected test, signature drift (`Shutdown` with context);
go-limiter — agent-authored test file collides with the injected test
(duplicate `fakeClock`), `Clock` interface churn (`now` vs `Now`); go-rename s1
— partial rename (`undefined: memStore`); emitter/extract-validate s2/s3 —
module-graph breakage (verify require crash); csvstats s1 — count assert;
py-plugins s2 — duplicate registration handling.

Outcome hygiene: 2 records first labeled TOOL_FAILURE (go-pool s1, go-limiter
s2) were reclassified to MODEL_FAILURE on 2026-10-02 — compile errors in
agent-written code are fixable by the agent; the TOOL keyword came from agent
prose, not the check output. `classifyAbort` was tightened the same day
(TOOL pattern must match `verifyDetail`; exception path unchanged) with
regression tests. No other outcomes affected.

Late regression (transcript heuristic, upper bound): **15 of 18 failed runs**
show ≥1 green command followed by a later file write. Heuristic counts
print-only greens too, so read it as pattern prevalence, not a precise count.
It is not assumed zero — the `apiLock` row must move it.

Efficiency: median turns 30 (the cap — flags-off wandering confirmed);
`turnsToGreen` carries the print-only inflation caveat from the pilot (e.g.
rename-chain s1 recorded g13 over 30 turns). Secondary columns (not the score):
`latencyConstrained` 12 runs, `turnConstrained` 16 runs. Latency split holds
across the suite: median TTFT 1,321 ms, median `genMsPerToken` 29.4 on low
output tokens → reasoning effort dominates; 126 provider retries total, 0 infra
outcomes outstanding (1 RATE_LIMIT auto-reran to pass).

Suite cost (blocks Phase 4 — grid may start): input 16,745,317 tokens
(s1 5,868,724 / s2 5,797,172 / s3 5,079,421), output 288,092
(s1 90,294 / s2 95,565 / s3 102,233); wall 11,562 s (s1 5,225 / s2 2,665 /
s3 3,672). Dollars: model pricing unknown to the estimator (`costUsd` 0) —
take them from NVIDIA billing before multiplying out the 9-run Phase 4 grid.
Concurrency stays 1 (429s observed at sequential load).
Pilot datapoint below is NOT the baseline — 1 task, 1 seed, flags off.

### Pilot: adv-ts-import-cycle seed1 (2026-10-01, flags off, NOT the baseline)

- Model: `nvidia/nemotron-3-ultra-550b-a55b` via OpenAI-compat endpoint.
- Result: PASS, 29 turns, 422 s. `turnsToGreen` recorded 3 — KNOWN LABEL CAVEAT:
  turn 3 was a print-only `node -e` (`console.log`, exit 0, no assertion), so the
  first *real* green check was ~turn 7. Turns-to-green counts the first exit-0
  non-empty command; print-only checks inflate it. The bias is identical across
  flag rows, so paired comparisons still cancel it, but do not read it as
  "verified in 3 turns".
- Tokens: input 339,882, output 5,675, `reasoningTokens: null` (provider omits
  them), `usageEstimated: false`, cost $0.0000 (model pricing unknown to the
  estimator — take dollars from NVIDIA billing, not from this field).
- Latency split: TTFT 1,352 ms, queue ≈ 1,289 ms, generation 327 s of 422 s
  (77%). `genMsPerToken` 57.6 with low output tokens → reasoning effort, not
  generation length, dominates — same shape as the v1 "89% thought" log.
  Provider queue is NOT the wait (retries were `overloaded`/429, not slow headers).
- Retries: `providerRetries` 3 in the results file, but the console showed ~7
  outer retries plus 2 agent-level 10 s rate-limit backoffs. Root cause found:
  retries on *failed* model calls (which then hit the agent backoff path) were
  never emitted. Fixed same day: `callModel` now emits a 0-token usage event
  carrying the retry count before rethrowing, so future runs capture all of them.
- Loop waste, flags off (all predicted by the plan): fixed by ~turn 7, wandered
  to turn 29 re-reading/re-verifying (`stopOnGreen` target); `.codeagent/audit.jsonl`
  leaked into `glob`/`list_files` and the model read it (turn 28 — `searchIgnores`
  target); `git_diff` ran outside a git repo (`hideGit` target); four empty-output
  `node -e` exit-0 runs (turns 13, 15–17 — `emptySuccess` target).
- Rough suite math (do NOT quote as a result): ~340k in / ~5.7k out per task on
  a wander-heavy task → ~6.8M input tokens per 20-task seed before any stopping
  fix; ~2.3 h wall per seed sequential. 429s already appear at concurrency 1,
  so do NOT parallelize above 1 without re-testing. Dollars: fill from NVIDIA
  billing before launching the Phase 4 grid.

### Smoke test (Windows-feasible, not a score)

- 5 pinned Aider polyglot exercises, dataset revision: _not yet run_.
  Same build, flags off. Only question: can the agent edit a foreign repo
  without dying on path/shell/tool shape? Five exercises cannot separate
  agents; no percent is quoted. SWE-bench waits on a Linux container.

## Flag ablation (Phase 2 groups + Phase 4 A–E)

Keep rule: pass-rate flag needs a flip in 2 of 3 seeds, confirmed at 5 seeds
on flipped tasks, no stable pass becomes stable fail, plus a combination run.
Efficiency (turns to first green at cap 30, wall time + tokens supporting)
is a second keep. Hygiene + economy are on for every behavioral row.

| Flag | 3-seed screen | 5-seed confirm | Turns-to-green | Late-regressions | Keep/drop |
| --- | --- | --- | --- | --- | --- |
| hygiene group | SCREEN DONE 2026-10-02: 49/60 (seeds 17/15/17) vs baseline 42/60 (13/14/15); paired turns-to-green median −1 (5 vs 6, n=30). Sole 2-seed flip: emitter (base F,F → hyg P,P on s2,s3). No 2-seed stable-pass breakage (event-tests s2 single break: watch). 5-seed confirm on emitter: 5/5 PASS (seeds 4–8, 7–17 turns). Tokens 15.18M in / 263k out | 5/5 | turns-to-green −1 paired | late-regressions tracked at combination | KEEP (combination run still required by plan) |
| economy group | not run (blocked behind the skipped grid) | — | — | — | — |
| A progressRedirect | not run | — | — | — | — |
| B apiLock | not run | — | — | — | — |
| C contractTests | not run | — | — | — | — |
| D stopOnGreen | not run | — | — | — | — |
| E fastExplore | not run | — | — | — | — |
| combination (kept set) | not run | — | — | — | candidate |

Dropped flags are removed from the tree. No runtime rule names `next()`,
`jsonutil`, or a single task id.

## Phase 5 — wider suite (not started)

- 40+ tasks before any "agent improved at coding" sentence (real TS with
  `tsc` in verify, multi-module Python, Go module, 50+ file fixture; v2 stays frozen).
- Foreign-repo: larger pinned Aider list after the smoke test, per-exercise,
  no leaderboard percent. SWE-bench Verified / Terminal-Bench only with a
  Linux container (ids + revisions pinned).

## Phase 6 — product completeness (not started)

Gaps (exist in part, not closed; eval stays auto-approve):

- Sandbox: `src/tools/sandbox.ts`, `/sandbox docker|local`, per-run
  `commandRunner`. Docker path unproven vs eval; network egress is a separate
  permission; local mode is not a sandbox.
- Permissions: `PermissionManager` (`default`, `acceptEdits`, `plan`,
  `bypass`). Interactive deny/allow stays fail-closed with no checker (MCP
  already does). UX: prompt names command + file; deny returns to a
  different action. Do not loosen eval auto-approve into default CLI.
- Checkpoints/undo: git shadow commits + `FileStateCache.rollback`. Undo on
  non-git workspace (every eval repo): one command restores last green hash.
- Session resume: `src/session/sessionManager.ts` persists history/usage. A
  `RATE_LIMIT` death resumes from last green verification, not from scratch.
- Subagents: `runSubagent`/parallel for explore on 50+ file tasks only; no
  fan-out on 4-file fixtures.
- Large-repo context: `rankedRepoMap`, compactor, symbol outline. On 50+ file
  fixture: ranked list in prompt (not flat dump); compaction keeps contract
  lock + last failure; measure `preserve` survival.
- LSP: quick diagnostics today (`transpileModule`, ruff, `go vet`, cargo).
  Optional `tsc`/`pyright`/`gopls` when installed; fallback stays.
- CLI UX: `src/cli/repl.ts`, `src/cli/ui/reporter.ts`. Streaming tool
  output, cost when usage exists, permission mode, remaining budget, resume
  visible. No new visual system.
- Observability: `logAudit` `.codeagent/audit.jsonl` (hidden from search by
  hygiene). JSONL trace is the operator view: turn, tool, class, cost, queue.
- Security: secret-path refusal, command blocklist, truncated output. Keys
  never enter tool output; review blocklist when `shellHint` lands so a
  temp-script path cannot bypass it.

## Notes

- `genMsPerToken` is a rough ratio (generationMs / estimated output tokens),
  never an absolute tok/s rate and never a cost-model input. Compare across
  turns/tasks only. Reasoning tokens are `null` when the provider omits them.
- Smoke: base suite validated by `npm run eval` (see `eval/results/smoke.json`).
  Prompt version: `codeagent-prompt/2.2`.
