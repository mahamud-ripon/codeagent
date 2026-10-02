/**
 * QA-1 live baseline (EVAL_LIVE=1): scores the smoke task set against a real
 * model endpoint and writes eval/results/live.json.
 * Requires a configured provider (OPENAI_API_KEY / ANTHROPIC_API_KEY /
 * GEMINI_API_KEY, or OPENAI_BASE_URL + MODEL for local/compat endpoints).
 * Without an endpoint it exits 2 with a clear message (no fake numbers).
 *
 * Each task runs in a throwaway tmp repo (files from eval/tasks.json) with
 * auto-approve on, so live runs never touch the real checkout. A task scores
 * `ok` when its `expect` substring appears in the final message or in any
 * file after the run. Selection: EVAL_TASKS=id1,id2 EVAL_LIMIT=n.
 * Advanced suite: EVAL_TASKS_FILE=tasks-advanced.json runs the hard-task
 * suite (optional per-task `verify` hidden checks, `timeoutSec`,
 * `maxIterations`); results go to eval/results/live-advanced.json so the
 * base baseline is never clobbered.
 *
 * Phase 0-3: advanced-v1 is frozen history; advanced-v2 is the suite under
 * development (600 s / 30 turns primary, 180 s + 15 turns secondary columns,
 * per-turn UTF-8 JSONL, v2 abort taxonomy, one infra auto-rerun).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { query } from "../src/sdk/query.js";
import { checkExpectMatch, renderLiveSummary, summarizeLive, writeLiveResults, isInfraOutcome, type LiveTaskResult } from "./score.js";
import { appendTurnRecord, classifyAbort, failureClassFromToolOutput, genMsPerToken } from "./instrument.js";
import { parseFlagNames, DEFAULT_RUNTIME_FLAGS, type RuntimeFlags } from "../src/agent/runtimeFlags.js";
import { loadGlobalEnv } from "../src/cli/config.js";

loadGlobalEnv();

const root = path.dirname(fileURLToPath(import.meta.url));
const live = process.env.EVAL_LIVE === "1";
if (!live) {
  console.log("eval:live needs EVAL_LIVE=1 and a model endpoint. Smoke runner is `npm run eval`.");
  process.exit(2);
}

const hasKey = !!process.env.OPENAI_API_KEY || !!process.env.ANTHROPIC_API_KEY || !!process.env.GEMINI_API_KEY;
const hasEndpoint = !!process.env.OPENAI_BASE_URL;
if (!hasKey && !hasEndpoint) {
  console.error("eval:live: no model endpoint configured (set OPENAI_API_KEY or OPENAI_BASE_URL + MODEL).");
  process.exit(2);
}

interface Task {
  id: string;
  bucket: string;
  language: string;
  prompt: string;
  files: Record<string, string>;
  expect: string;
  /** Hidden post-run check (written to the tmp repo only after the agent
   * finishes, so the agent can never see or game it). */
  verify?: { file: string; content: string; run: string; expectOut?: string };
  /** Per-task budget overrides (defaults: 180 s, 15 iterations; v2: 600 s, 30). */
  timeoutSec?: number;
  maxIterations?: number;
}

const tasksFile = (process.env.EVAL_TASKS_FILE ?? "tasks.json").replace(/[^a-z0-9_.-]+/gi, "-");
const tasks = JSON.parse(fs.readFileSync(path.join(root, tasksFile), "utf8")) as Task[];
// Advanced suites write beside the base baseline instead of clobbering it:
// tasks.json -> live.json, tasks-advanced.json -> live-advanced.json.
const stem = tasksFile.replace(/\.json$/i, "");
// Phase 4 ablation rows: EVAL_FLAGS selects flags (comma names or A-E),
// EVAL_LABEL segregates outputs so a flag row can never clobber the baseline.
// A non-default flag set without a label is a hard error.
const rowFlags: RuntimeFlags = parseFlagNames(process.env.EVAL_FLAGS ?? "");
const flagsOn = (Object.keys(DEFAULT_RUNTIME_FLAGS) as (keyof RuntimeFlags)[]).some((k) => rowFlags[k]);
const label = (process.env.EVAL_LABEL ?? "").replace(/[^a-z0-9-]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 40);
if (flagsOn && !label) {
  console.error("eval:live: EVAL_FLAGS selects flags but EVAL_LABEL is empty — refusing to run (would clobber baseline files).");
  process.exit(2);
}
const outBase = (stem === "tasks" ? "live" : `live-${stem.replace(/^tasks-?/, "") || "custom"}`) + (label ? `-${label}` : "");
const outFile = `${outBase}.json`;
const suiteForJsonl = (stem.replace(/^tasks-?/, "") || "custom") + (label ? `-${label}` : "");
if (flagsOn || label) {
  console.log(`eval live row: flags=${JSON.stringify(rowFlags)} label=${label || "(none)"} -> ${outFile} + results/${suiteForJsonl}/`);
}
const isV2 = /advanced-v2/.test(tasksFile);
const seed = Math.max(1, Number(process.env.EVAL_SEED ?? "1") || 1);
const only = (process.env.EVAL_TASKS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const limit = Number(process.env.EVAL_LIMIT ?? "0") || tasks.length;
const chunk = Number(process.env.EVAL_CHUNK ?? "0");
const chunkSize = Number(process.env.EVAL_CHUNK_SIZE ?? "3");

let selected: Task[];
if (chunk > 0) {
  const start = (chunk - 1) * chunkSize;
  selected = tasks.slice(start, start + chunkSize);
} else {
  selected = tasks.filter((t) => only.length === 0 || only.includes(t.id)).slice(0, Math.max(1, limit));
}
if (selected.length === 0) {
  console.error("eval:live: selection matched no tasks (check EVAL_TASKS or EVAL_CHUNK).");
  process.exit(2);
}

/** Run a hidden verify command inside the task repo (shell of the host OS). */
import { exec } from "node:child_process";
function runVerify(
  cmd: string,
  cwd: string,
  timeoutMs = 90_000,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    exec(cmd, { cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      const code = (err as { code?: unknown } | null)?.code;
      resolve({
        exitCode: typeof code === "number" ? code : err ? 1 : 0,
        stdout: String(stdout ?? ""),
        stderr: String(stderr ?? ""),
      });
    });
  });
}

/** Read back all task files (bounded) so `expect` can match edited content. */
function collectWorktreeText(dir: string): string {
  const parts: string[] = [];
  let budget = 200_000;
  const walk = (d: string): void => {
    if (budget <= 0) return;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === ".git" || e.name === ".codeagent" || e.name === "node_modules") continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        walk(full);
      } else {
        try {
          const stat = fs.statSync(full);
          if (stat.size > 50_000) continue;
          const text = fs.readFileSync(full, "utf8");
          parts.push(text.slice(0, budget));
          budget -= text.length;
        } catch {
          // unreadable file — ignore
        }
      }
      if (budget <= 0) return;
    }
  };
  walk(dir);
  return parts.join("\n");
}

function effectiveBudget(task: Task): { timeoutSec: number; maxIterations: number } {
  if (isV2) {
    // Primary v2 budget is 600 s / 30 turns. Per-task overrides never lower it.
    return {
      timeoutSec: Math.max(600, task.timeoutSec ?? 600),
      maxIterations: Math.max(30, task.maxIterations ?? 30),
    };
  }
  return { timeoutSec: task.timeoutSec ?? 180, maxIterations: task.maxIterations ?? 15 };
}

async function runOneTask(task: Task, attempt: number): Promise<LiveTaskResult> {
  const { timeoutSec, maxIterations } = effectiveBudget(task);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `codeagent-eval-${task.id}-`));
  for (const [rel, content] of Object.entries(task.files)) {
    const full = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  const started = Date.now();
  const deadlineMs = Math.max(30, timeoutSec) * 1000;
  let ttftMs: number | undefined;
  let queueMs: number | undefined;
  let turns = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let reasoningTokens: number | null = null;
  let usageEstimated = false;
  let costUsd = 0;
  let generationMsTotal = 0;
  let providerRetries = 0;
  // Per-turn usage is last-wins: some proxies emit duplicate identical
  // usage chunks per turn, which naive += would double-count (observed
  // live: two identical {input,output} events closing one turn).
  let turnInput = 0;
  let turnOutput = 0;
  let turnReasoning: number | null = null;
  let turnEstimated = false;
  let turnRetries = 0;
  let turnCost = 0;
  let turnStart = started;
  let turnFirstTokenAt: number | undefined;
  let turnToolMs = 0;
  let turnFailureClass: string | undefined;
  let toolStartAt: number | undefined;
  let turnsToGreen: number | undefined;
  let firstVerificationResult: string | undefined;
  const flushTurn = (turnNo: number): void => {
    if (turnNo <= 0) return;
    const now = Date.now();
    const turnMs = now - turnStart;
    const genMs = turnFirstTokenAt !== undefined ? now - turnFirstTokenAt : undefined;
    const genRatio = genMs !== undefined ? genMsPerToken(genMs, Math.max(1, turnOutput)) : undefined;
    if (genMs !== undefined) generationMsTotal += genMs;
    inputTokens += turnInput;
    outputTokens += turnOutput;
    if (turnReasoning != null) reasoningTokens = (reasoningTokens ?? 0) + turnReasoning;
    if (turnEstimated) usageEstimated = true;
    providerRetries += turnRetries;
    costUsd += turnCost;
    try {
      appendTurnRecord(path.join(root, ".."), suiteForJsonl, task.id, seed, {
        taskId: task.id,
        seed,
        turn: turnNo,
        queueMs,
        ttftMs: turnFirstTokenAt !== undefined ? turnFirstTokenAt - turnStart : undefined,
        reasoningTokens: turnReasoning,
        outputTokens: turnOutput,
        inputTokens: turnInput,
        usageEstimated: turnEstimated,
        generationMs: genMs,
        genMsPerToken: genRatio,
        toolMs: turnToolMs,
        providerRetries: turnRetries,
        turnMs,
        failureClass: turnFailureClass,
      });
    } catch {
      // JSONL is best-effort; scoring continues without it
    }
    turnInput = 0;
    turnOutput = 0;
    turnReasoning = null;
    turnEstimated = false;
    turnRetries = 0;
    turnCost = 0;
    turnToolMs = 0;
    turnFailureClass = undefined;
    turnFirstTokenAt = undefined;
    toolStartAt = undefined;
  };
  let finalMessage = "";
  let ok = false;
  let verifyDetail = "";
  let verifyOk = true;
  let threw = false;
  try {
    const signal = AbortSignal.timeout(deadlineMs);
    for await (const event of query(task.prompt, {
      repoRoot: tmp,
      autoApprove: true,
      maxIterations,
      signal,
      flags: rowFlags,
    })) {
      if (event.type === "turn_start") {
        if (turns > 0) flushTurn(turns);
        turns += 1;
        turnStart = Date.now();
      } else if (event.type === "usage") {
        turnInput = event.input;
        turnOutput = event.output;
        turnReasoning = (event as { reasoningTokens?: number | null }).reasoningTokens ?? null;
        turnEstimated = (event as { usageEstimated?: boolean }).usageEstimated ?? false;
        turnRetries = (event as { providerRetries?: number }).providerRetries ?? turnRetries;
        turnCost = event.costUsd ?? 0;
      } else if (event.type === "tool_start") {
        toolStartAt = Date.now();
        if (turnFirstTokenAt === undefined) {
          turnFirstTokenAt = Date.now();
          if (ttftMs === undefined) ttftMs = turnFirstTokenAt - started;
          if (queueMs === undefined) queueMs = turnFirstTokenAt - turnStart;
        }
      } else if (event.type === "tool_end") {
        const ms = (event as { ms?: number }).ms ?? (toolStartAt !== undefined ? Date.now() - toolStartAt : 0);
        turnToolMs += ms;
        toolStartAt = undefined;
        const out = (event as { output?: string }).output ?? "";
        turnFailureClass = failureClassFromToolOutput(out);
        if (turnsToGreen === undefined && /exit code:\s*0/i.test(out) && out.trim().length > 0) {
          // First green targeted check (label only; empty stdout is not green).
          const nonEmpty = out.replace(/exit code:\s*0/i, "").trim().length > 0;
          if (nonEmpty) {
            turnsToGreen = turns;
            if (firstVerificationResult === undefined) firstVerificationResult = "green";
          }
        } else if (firstVerificationResult === undefined && /exit code:\s*[1-9]/i.test(out)) {
          firstVerificationResult = "red";
        }
      } else if (event.type === "done") {
        const result = event.result as { finalMessage?: unknown } | undefined;
        if (typeof result?.finalMessage === "string") finalMessage = result.finalMessage;
      } else if (event.type === "text_delta" || event.type === "thinking_delta") {
        if (turnFirstTokenAt === undefined) {
          turnFirstTokenAt = Date.now();
          if (ttftMs === undefined) ttftMs = turnFirstTokenAt - started;
          if (queueMs === undefined) queueMs = turnFirstTokenAt - turnStart;
        }
      }
      if (ttftMs === undefined && (event.type === "text_delta" || event.type === "tool_start" || event.type === "thinking_delta")) {
        ttftMs = Date.now() - started;
      }
    }
    // Hidden behavioral check: written into the tmp repo only after the
    // agent finishes (the agent can never see or game it), executed, then
    // deleted before scoring so it never leaks into expect matching.
    if (task.verify) {
      const vfile = path.join(tmp, task.verify.file);
      try {
        fs.writeFileSync(vfile, task.verify.content);
        const out = await runVerify(task.verify.run, tmp);
        if (out.exitCode !== 0) {
          verifyOk = false;
          verifyDetail = `verify "${task.verify.run}" exited ${out.exitCode}: ${(out.stdout + out.stderr).slice(-400)}`;
          if (firstVerificationResult === undefined) firstVerificationResult = "red";
        } else if (task.verify.expectOut && !out.stdout.includes(task.verify.expectOut)) {
          verifyOk = false;
          verifyDetail = `verify output missing ${JSON.stringify(task.verify.expectOut)}`;
          if (firstVerificationResult === undefined) firstVerificationResult = "red";
        } else if (firstVerificationResult === undefined) {
          firstVerificationResult = "green";
        }
      } catch (e) {
        verifyOk = false;
        verifyDetail = `verify error: ${e instanceof Error ? e.message : String(e)}`;
      } finally {
        try {
          fs.rmSync(vfile, { force: true });
        } catch {
          // ignore cleanup failures
        }
      }
    }
    const haystack = `${finalMessage}\n${collectWorktreeText(tmp)}`;
    ok = checkExpectMatch(haystack, task.expect) && verifyOk;
    flushTurn(turns);
  } catch (e) {
    finalMessage = e instanceof Error ? e.message : String(e);
    ok = false;
    threw = true;
    try {
      flushTurn(turns);
    } catch {
      // ignore
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  const elapsedMs = Date.now() - started;
  const seconds = elapsedMs / 1000;

  let outcome: LiveTaskResult["outcome"];
  let failureReason: string | undefined;
  if (ok) {
    outcome = isV2 ? "PASS" : "TASK_PASS";
  } else if (isV2) {
    const cls = classifyAbort({
      message: finalMessage + "\n" + verifyDetail,
      verifyDetail,
      fromException: threw,
      deadlineMs,
      elapsedMs,
      timedOut: elapsedMs >= deadlineMs - 5000,
    });
    outcome = cls;
    if (cls === "TIMEOUT") failureReason = `Task deadline ${timeoutSec}s reached: ${finalMessage.slice(0, 200)}`;
    else if (cls === "RATE_LIMIT") failureReason = "Model rate limit exceeded";
    else if (cls === "PROVIDER_FAILURE") failureReason = "Upstream provider service unavailable";
    else if (cls === "TOOL_FAILURE") failureReason = `Tool/environment failure: ${(verifyDetail || finalMessage).slice(0, 300)}`;
    else if (cls === "EVALUATOR_FAILURE") failureReason = verifyDetail || "Verifier crashed";
    else if (verifyDetail) failureReason = verifyDetail;
    else failureReason = `Expected "${task.expect}" not found in output or worktree`;
    // SPEC_AMBIGUITY should be empty on v2; flag it when prompt/verifier disagree.
    void firstVerificationResult;
  } else {
    if (/timeout|aborted due to timeout/i.test(finalMessage)) {
      outcome = "MODEL_TIMEOUT";
      failureReason = "Operation aborted due to timeout";
    } else if (/rate.?limit|429/i.test(finalMessage)) {
      outcome = "MODEL_RATE_LIMIT";
      failureReason = "Model rate limit exceeded";
    } else if (/503|service unavailable|no available workers|circuits open|upstream error/i.test(finalMessage)) {
      outcome = "PROVIDER_ERROR";
      failureReason = "Upstream provider service unavailable";
    } else if (verifyDetail) {
      outcome = "TASK_FAIL";
      failureReason = verifyDetail;
    } else {
      outcome = "TASK_FAIL";
      failureReason = `Expected "${task.expect}" not found in output or worktree`;
    }
  }

  const avgGen = turns > 0 && outputTokens > 0 ? generationMsTotal / Math.max(1, outputTokens) : undefined;
  const result: LiveTaskResult = {
    taskId: task.id,
    ok,
    outcome,
    failureReason: attempt > 0 && failureReason ? `[attempt ${attempt + 1}] ${failureReason}` : failureReason,
    turns,
    turnsToGreen: ok ? turnsToGreen : undefined,
    inputTokens,
    outputTokens,
    reasoningTokens,
    usageEstimated,
    costUsd,
    seconds,
    ttftMs,
    queueMs,
    generationMs: generationMsTotal || undefined,
    genMsPerToken: avgGen,
    providerRetries,
    latencyConstrained: isV2 ? seconds * 1000 >= 180_000 && !ok : undefined,
    turnConstrained: isV2 ? turns >= 15 && !ok : undefined,
  };
  return result;
}

const results: LiveTaskResult[] = [];
for (const task of selected) {
  let first = await runOneTask(task, 0);
  // Infra auto-rerun once inside this phase; the model table uses the rerun
  // when the first attempt is TIMEOUT/RATE_LIMIT/PROVIDER_FAILURE.
  if (isInfraOutcome(first.outcome)) {
    console.log(`eval live: ${task.id} ${first.outcome} (infra) — auto-rerun once`);
    const second = await runOneTask(task, 1);
    console.log(`eval live: ${task.id} retry ${second.outcome} (${second.turns} turns, ${second.seconds.toFixed(1)}s)`);
    results.push(second);
  } else {
    results.push(first);
    console.log(`eval live: ${task.id} ${first.outcome} (${first.turns} turns, ${first.seconds.toFixed(1)}s)`);
  }

  if (chunk > 0) {
    const chunkSummary = summarizeLive(results);
    chunkSummary.flags = rowFlags;
    const chunkFile = path.join(root, "results", `${outBase}-fast${chunk}.json`);
    fs.writeFileSync(chunkFile, JSON.stringify({ ...chunkSummary, at: new Date().toISOString() }, null, 2));
  } else {
    if (results.length % chunkSize === 0) {
      const chunkIdx = Math.floor(results.length / chunkSize);
      const chunkSummary = summarizeLive(results.slice(results.length - chunkSize));
      chunkSummary.flags = rowFlags;
      const chunkFile = path.join(root, "results", `${outBase}-fast${chunkIdx}.json`);
      fs.writeFileSync(chunkFile, JSON.stringify({ ...chunkSummary, at: new Date().toISOString() }, null, 2));
    }
    const runningSummary = summarizeLive(results);
    runningSummary.flags = rowFlags;
    await writeLiveResults(path.join(root, ".."), runningSummary, outFile);
  }
}

const summary = summarizeLive(results);
summary.flags = rowFlags;
if (chunk > 0) {
  const chunkFile = path.join(root, "results", `${outBase}-fast${chunk}.json`);
  console.log(renderLiveSummary(summary));
  console.log(`Wrote chunk ${chunk} to ${chunkFile}`);
} else {
  const file = await writeLiveResults(path.join(root, ".."), summary, outFile);
  console.log(renderLiveSummary(summary));
  console.log(`Wrote ${file}`);
}
