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
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { query } from "../src/sdk/query.js";
import { checkExpectMatch, renderLiveSummary, summarizeLive, writeLiveResults, type LiveTaskResult } from "./score.js";
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
  /** Per-task budget overrides (defaults: 180 s, 15 iterations). */
  timeoutSec?: number;
  maxIterations?: number;
}

const tasksFile = (process.env.EVAL_TASKS_FILE ?? "tasks.json").replace(/[^a-z0-9_.-]+/gi, "-");
const tasks = JSON.parse(fs.readFileSync(path.join(root, tasksFile), "utf8")) as Task[];
// Advanced suites write beside the base baseline instead of clobbering it:
// tasks.json -> live.json, tasks-advanced.json -> live-advanced.json.
const stem = tasksFile.replace(/\.json$/i, "");
const outBase = stem === "tasks" ? "live" : `live-${stem.replace(/^tasks-?/, "") || "custom"}`;
const outFile = `${outBase}.json`;
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

const results: LiveTaskResult[] = [];
for (const task of selected) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `codeagent-eval-${task.id}-`));
  for (const [rel, content] of Object.entries(task.files)) {
    const full = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  const started = Date.now();
  let ttftMs: number | undefined;
  let turns = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;
  // Per-turn usage is last-wins: some proxies emit duplicate identical
  // usage chunks per turn, which naive += would double-count (observed
  // live: two identical {input,output} events closing one turn).
  let turnInput = 0;
  let turnOutput = 0;
  let turnCost = 0;
  const flushTurn = (): void => {
    inputTokens += turnInput;
    outputTokens += turnOutput;
    costUsd += turnCost;
    turnInput = 0;
    turnOutput = 0;
    turnCost = 0;
  };
  let finalMessage = "";
  let ok = false;
  let verifyDetail = "";
  try {
    const signal = AbortSignal.timeout(Math.max(30, task.timeoutSec ?? 180) * 1000);
    for await (const event of query(task.prompt, {
      repoRoot: tmp,
      autoApprove: true,
      maxIterations: task.maxIterations ?? 15,
      signal,
    })) {
      if (event.type === "turn_start") {
        flushTurn();
        turns += 1;
      } else if (event.type === "usage") {
        turnInput = event.input;
        turnOutput = event.output;
        turnCost = event.costUsd ?? 0;
      } else if (event.type === "done") {
        const result = event.result as { finalMessage?: unknown } | undefined;
        if (typeof result?.finalMessage === "string") finalMessage = result.finalMessage;
      }
      if (ttftMs === undefined && (event.type === "text_delta" || event.type === "tool_start" || event.type === "thinking_delta")) {
        ttftMs = Date.now() - started;
      }
    }
    // Hidden behavioral check: written into the tmp repo only after the
    // agent finishes (the agent can never see or game it), executed, then
    // deleted before scoring so it never leaks into expect matching.
    let verifyOk = true;
    if (task.verify) {
      const vfile = path.join(tmp, task.verify.file);
      try {
        fs.writeFileSync(vfile, task.verify.content);
        const out = await runVerify(task.verify.run, tmp);
        if (out.exitCode !== 0) {
          verifyOk = false;
          verifyDetail = `verify "${task.verify.run}" exited ${out.exitCode}: ${(out.stdout + out.stderr).slice(-400)}`;
        } else if (task.verify.expectOut && !out.stdout.includes(task.verify.expectOut)) {
          verifyOk = false;
          verifyDetail = `verify output missing ${JSON.stringify(task.verify.expectOut)}`;
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
    flushTurn();
  } catch (e) {
    finalMessage = e instanceof Error ? e.message : String(e);
    ok = false;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  const seconds = (Date.now() - started) / 1000;

  let outcome: import("./score.js").TaskOutcome = "TASK_FAIL";
  let failureReason: string | undefined;
  if (ok) {
    outcome = "TASK_PASS";
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

  results.push({ taskId: task.id, ok, outcome, failureReason, turns, inputTokens, outputTokens, costUsd, seconds, ttftMs });
  console.log(`eval live: ${task.id} ${outcome} (${turns} turns, ${seconds.toFixed(1)}s)`);

  if (chunk > 0) {
    const chunkSummary = summarizeLive(results);
    const chunkFile = path.join(root, "results", `${outBase}-fast${chunk}.json`);
    fs.writeFileSync(chunkFile, JSON.stringify({ ...chunkSummary, at: new Date().toISOString() }, null, 2));
  } else {
    if (results.length % chunkSize === 0) {
      const chunkIdx = Math.floor(results.length / chunkSize);
      const chunkSummary = summarizeLive(results.slice(results.length - chunkSize));
      const chunkFile = path.join(root, "results", `${outBase}-fast${chunkIdx}.json`);
      fs.writeFileSync(chunkFile, JSON.stringify({ ...chunkSummary, at: new Date().toISOString() }, null, 2));
    }
    const runningSummary = summarizeLive(results);
    await writeLiveResults(path.join(root, ".."), runningSummary, outFile);
  }
}

const summary = summarizeLive(results);
if (chunk > 0) {
  const chunkFile = path.join(root, "results", `${outBase}-fast${chunk}.json`);
  console.log(renderLiveSummary(summary));
  console.log(`Wrote chunk ${chunk} to ${chunkFile}`);
} else {
  const file = await writeLiveResults(path.join(root, ".."), summary, outFile);
  console.log(renderLiveSummary(summary));
  console.log(`Wrote ${file}`);
}
