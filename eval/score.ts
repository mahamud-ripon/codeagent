/**
 * QA-1 live scoring (EVAL_LIVE=1): pass rate, turns, tokens, cost, time.
 * The smoke runner validates schemas offline; this module scores live runs
 * and writes eval/results/live.json + a human-readable summary.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { PROMPT_VERSION } from "../src/agent/promptSections.js";

export type TaskOutcomeV1 = "TASK_PASS" | "TASK_FAIL" | "MODEL_TIMEOUT" | "MODEL_RATE_LIMIT" | "PROVIDER_ERROR";

/**
 * Phase 1 v2 abort taxonomy. Old enum values remain as aliases so the v1
 * historical file still loads. v2 uses the new taxonomy only.
 */
export type TaskOutcomeV2 =
  | "PASS"
  | "MODEL_FAILURE"
  | "TOOL_FAILURE"
  | "PROVIDER_FAILURE"
  | "EVALUATOR_FAILURE"
  | "SPEC_AMBIGUITY"
  | "TIMEOUT"
  | "RATE_LIMIT";

export type TaskOutcome = TaskOutcomeV1 | TaskOutcomeV2;

/** Map any outcome (v1 alias or v2) to its canonical v2 class. */
export function canonicalOutcome(o: string | undefined): TaskOutcomeV2 | string {
  switch (o) {
    case "TASK_PASS":
    case "PASS":
      return "PASS";
    case "TASK_FAIL":
    case "MODEL_FAILURE":
      return "MODEL_FAILURE";
    case "MODEL_TIMEOUT":
    case "TIMEOUT":
      return "TIMEOUT";
    case "MODEL_RATE_LIMIT":
    case "RATE_LIMIT":
      return "RATE_LIMIT";
    case "PROVIDER_ERROR":
    case "PROVIDER_FAILURE":
      return "PROVIDER_FAILURE";
    case "TOOL_FAILURE":
    case "EVALUATOR_FAILURE":
    case "SPEC_AMBIGUITY":
      return o;
    default:
      return o ?? "MODEL_FAILURE";
  }
}

/** Infra classes are excluded from the model rate and rerun once. */
export function isInfraOutcome(o: string | undefined): boolean {
  const c = canonicalOutcome(o);
  return c === "TIMEOUT" || c === "RATE_LIMIT" || c === "PROVIDER_FAILURE";
}

export interface LiveTaskResult {
  taskId: string;
  ok: boolean;
  outcome?: TaskOutcome;
  failureReason?: string;
  turns: number;
  /** Iteration of the first green targeted check (efficiency metric). */
  turnsToGreen?: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number | null;
  usageEstimated?: boolean;
  costUsd: number;
  seconds: number;
  /** F-1: ms to the first text/tool event of the task's first model call. */
  ttftMs?: number;
  queueMs?: number;
  generationMs?: number;
  genMsPerToken?: number;
  providerRetries?: number;
  /** Secondary columns (same trace, not the score). */
  latencyConstrained?: boolean;
  turnConstrained?: boolean;
}

export interface LiveSummary {
  total: number;
  passed: number;
  passRate: number;
  medianTurns: number;
  totalCostUsd: number;
  meanSeconds: number;
  /** F-1: median time-to-first-token across tasks that reported one. */
  medianTtftMs: number;
  /** F-8: prompt version the baseline ran against (regression gate). */
  promptVersion: string;
  counts?: {
    pass: number;
    fail: number;
    modelTimeout: number;
    modelRateLimit: number;
    providerError: number;
  };
  effectivePassRate?: number;
  results: LiveTaskResult[];
  /** Phase 4 ablation row that produced this summary (all off = baseline). */
  flags?: import("../src/agent/runtimeFlags.js").RuntimeFlags;
}

/**
 * Task `expect` strings may list alternatives separated by `|` (see
 * eval/tasks.json, e.g. "i <= n|i < n"). Any alternative matching the
 * final message or worktree counts as a pass. Pure, unit-tested.
 */
export function checkExpectMatch(haystack: string, expectPattern: string): boolean {
  if (expectPattern.includes("|")) {
    const parts = expectPattern.split("|").map((p) => p.trim()).filter(Boolean);
    return parts.some((p) => haystack.includes(p));
  }
  return haystack.includes(expectPattern);
}

export function summarizeLive(results: LiveTaskResult[]): LiveSummary {  const total = results.length;
  const passed = results.filter((r) => r.ok).length;
  const turns = [...results.map((r) => r.turns)].sort((a, b) => a - b);
  const medianTurns = turns.length ? turns[Math.floor(turns.length / 2)]! : 0;
  const ttfts = results.map((r) => r.ttftMs).filter((t): t is number => typeof t === "number").sort((a, b) => a - b);
  const canon = (r: LiveTaskResult): string => canonicalOutcome(r.outcome) as string;

  const counts = {
    pass: passed,
    fail: results.filter((r) => !r.ok && (canon(r) === "MODEL_FAILURE" || !r.outcome)).length,
    modelTimeout: results.filter((r) => canon(r) === "TIMEOUT").length,
    modelRateLimit: results.filter((r) => canon(r) === "RATE_LIMIT").length,
    providerError: results.filter((r) => canon(r) === "PROVIDER_FAILURE").length,
  };
  const infraErrors = counts.modelTimeout + counts.modelRateLimit + counts.providerError;
  const valid = total - infraErrors;
  const effectivePassRate = valid > 0 ? passed / valid : (total ? passed / total : 0);

  return {
    total,
    passed,
    passRate: total ? passed / total : 0,
    medianTurns,
    totalCostUsd: results.reduce((s, r) => s + r.costUsd, 0),
    meanSeconds: total ? results.reduce((s, r) => s + r.seconds, 0) / total : 0,
    medianTtftMs: ttfts.length ? ttfts[Math.floor(ttfts.length / 2)]! : 0,
    promptVersion: PROMPT_VERSION,
    counts,
    effectivePassRate,
    results,
  };
}

export async function writeLiveResults(repoRoot: string, summary: LiveSummary, name = "live.json"): Promise<string> {
  const dir = path.join(repoRoot, "eval", "results");
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, name);
  await fs.writeFile(file, JSON.stringify({ ...summary, at: new Date().toISOString() }, null, 2));
  return file;
}

export function renderLiveSummary(summary: LiveSummary): string {
  const lines = [
    `eval live: ${summary.passed}/${summary.total} passed (${(summary.passRate * 100).toFixed(1)}%)`,
  ];
  if (summary.counts && (summary.counts.modelTimeout > 0 || summary.counts.modelRateLimit > 0 || summary.counts.providerError > 0)) {
    const valid = summary.total - summary.counts.modelTimeout - summary.counts.modelRateLimit - summary.counts.providerError;
    const effPct = ((summary.effectivePassRate ?? 0) * 100).toFixed(1);
    lines.push(
      `breakdown: pass=${summary.counts.pass} fail=${summary.counts.fail} timeout=${summary.counts.modelTimeout} rate_limit=${summary.counts.modelRateLimit} provider_err=${summary.counts.providerError}`,
      `effective pass rate (excluding infra outages): ${summary.passed}/${valid} (${effPct}%)`,
    );
  }
  lines.push(
    `median turns: ${summary.medianTurns} · cost: $${summary.totalCostUsd.toFixed(4)} · mean: ${summary.meanSeconds.toFixed(1)}s`,
    `median ttft: ${summary.medianTtftMs}ms · prompt: ${summary.promptVersion}`,
  );
  return lines.join("\n");
}
