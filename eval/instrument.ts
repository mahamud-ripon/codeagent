/**
 * Phase 1 instrumentation (plan.md): per-turn JSONL, usage estimation,
 * abort taxonomy (v2 only), and loop scorecard labels.
 *
 * No agent policy changes here — labels only.
 */
import fs from "node:fs";
import path from "node:path";

export type AbortClassV2 =
  | "PASS"
  | "MODEL_FAILURE"
  | "TOOL_FAILURE"
  | "PROVIDER_FAILURE"
  | "EVALUATOR_FAILURE"
  | "SPEC_AMBIGUITY"
  | "TIMEOUT"
  | "RATE_LIMIT";

export interface TurnRecord {
  taskId: string;
  seed: number;
  turn: number;
  queueMs?: number;
  ttftMs?: number;
  reasoningTokens: number | null;
  outputTokens: number;
  inputTokens: number;
  usageEstimated: boolean;
  generationMs?: number;
  genMsPerToken?: number;
  toolMs?: number;
  providerRetries: number;
  turnMs?: number;
  failureClass?: string;
  thoughtMs?: number;
}

export interface ScorecardLabels {
  firstVerificationResult?: string;
  turnsToGreen?: number;
  repeatedCallRate?: number;
  toolErrorRate?: number;
  lateRegressionCount: number;
  publicApiBreakCount: number;
  testsGeneratedWhenNoneExisted: boolean;
  nextEditFollowedFailure?: boolean;
  diffSize?: number;
  unrelatedFiles?: number;
  thoughtMsVsToolMs?: { thoughtMs: number; toolMs: number };
}

/** Rough output-token estimate from text length (chars/4). */
export function estimateOutputTokens(text: string): number {
  return Math.max(1, Math.round(text.length / 4));
}

export function estimateInputTokens(text: string): number {
  return Math.max(1, Math.round(text.length / 4));
}

export interface UsageInput {
  input_tokens?: number;
  prompt_tokens?: number;
  output_tokens?: number;
  completion_tokens?: number;
  reasoning_tokens?: number;
  reasoning?: { tokens?: number };
  output?: number;
  input?: number;
}

export interface NormalizedUsage {
  input: number;
  output: number;
  reasoningTokens: number | null;
  usageEstimated: boolean;
}

/**
 * Normalize provider usage chunks.
 * - Accepts input_tokens/prompt_tokens and output_tokens/completion_tokens.
 * - reasoningTokens is null when the provider omits it (not zero).
 * - When usage is absent, estimates from text and sets usageEstimated.
 */
export function normalizeUsage(raw: UsageInput | null | undefined, fallbackText = ""): NormalizedUsage {
  if (!raw) {
    const est = estimateOutputTokens(fallbackText);
    return { input: 0, output: est, reasoningTokens: null, usageEstimated: true };
  }
  const input = raw.input_tokens ?? raw.prompt_tokens ?? raw.input ?? 0;
  const output = raw.output_tokens ?? raw.completion_tokens ?? raw.output ?? 0;
  const reasoning =
    raw.reasoning_tokens ?? raw.reasoning?.tokens ?? null;
  const estimated = input === 0 && output === 0;
  if (estimated) {
    return {
      input: 0,
      output: estimateOutputTokens(fallbackText) || 1,
      reasoningTokens: null,
      usageEstimated: true,
    };
  }
  return {
    input,
    output,
    reasoningTokens: typeof reasoning === "number" ? reasoning : null,
    usageEstimated: false,
  };
}

/** genMsPerToken is a ratio, not a tok/s measurement. Compare across turns only. */
export function genMsPerToken(generationMs: number | undefined, outputTokens: number): number | undefined {
  if (generationMs == null || !Number.isFinite(generationMs) || outputTokens <= 0) return undefined;
  return generationMs / outputTokens;
}

/**
 * Classify an aborted/failed task from the timer + error class.
 * Old enum values remain as aliases (handled in score.ts).
 * A "Provider request cancelled" AT the task deadline is TIMEOUT, not TASK_FAIL.
 *
 * TOOL_FAILURE is deliberately narrow: the pattern must appear in the failed
 * check's own output (`verifyDetail`), never in the agent's prose. Agent-written
 * code that does not compile (e.g. a Go build error) is MODEL_FAILURE even
 * when the agent's summary mentions CGO, -race, or a missing binary in
 * passing. The only exception is the thrown-exception path (`fromException`),
 * where there is no verify output and the exception text IS the tool output.
 */
export function classifyAbort(opts: {
  message: string;
  verifyDetail?: string;
  fromException?: boolean;
  deadlineMs: number;
  elapsedMs: number;
  timedOut: boolean;
}): AbortClassV2 {
  const msg = opts.message || "";
  const vd = opts.verifyDetail ?? "";
  if (/rate.?limit|429/i.test(msg)) return "RATE_LIMIT";
  if (/503|service unavailable|no available workers|circuits open|upstream error|overloaded/i.test(msg)) {
    // Overloaded at the deadline with no other signal is still provider-side.
    return "PROVIDER_FAILURE";
  }
  if (/provider request cancelled/i.test(msg)) {
    // At/near the task AbortSignal deadline -> task-budget TIMEOUT.
    if (opts.timedOut || opts.elapsedMs >= opts.deadlineMs - 5000) return "TIMEOUT";
    return "PROVIDER_FAILURE";
  }
  if (/aborted due to timeout|operation aborted due to timeout|timed out after/i.test(msg)) return "TIMEOUT";
  if (/timeout/i.test(msg) && (opts.timedOut || opts.elapsedMs >= opts.deadlineMs - 5000)) return "TIMEOUT";
  const toolHaystack = opts.fromException ? msg : vd;
  if (/ripgrep.*not found|missing `rg`|CGO|go test -race|ENOENT.*go/i.test(toolHaystack)) return "TOOL_FAILURE";
  if (/verifier crashed|required a name the prompt does not state/i.test(msg)) return "EVALUATOR_FAILURE";
  return "MODEL_FAILURE";
}

/** Failure class from a tool output string (label only, never changes action). */
export function failureClassFromToolOutput(output: string): string {
  const o = output || "";
  if (/exit code:\s*0/i.test(o) && o.trim().length > 0) return "pass";
  if (/old_text was not found|not found/i.test(o)) return "missing-file";
  if (/rate.?limit|429/i.test(o)) return "rate-limit";
  if (/timeout|timed out/i.test(o)) return "timeout";
  if (/syntax|THINK|error TS|ruff|go vet|py_compile/i.test(o)) return "diagnostic";
  if (/exit code:\s*[1-9]/i.test(o)) return "test-red";
  return "other";
}

export function turnRecordLine(r: TurnRecord): string {
  return JSON.stringify(r);
}

/** Append one UTF-8 JSONL turn record. Creates dirs as needed. */
export function appendTurnRecord(repoRoot: string, suite: string, taskId: string, seed: number, rec: TurnRecord): void {
  const dir = path.join(repoRoot, "eval", "results", suite);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${taskId}-seed${seed}.jsonl`);
  fs.appendFileSync(file, `${turnRecordLine({ ...rec, taskId, seed })}\n`, "utf8");
}
