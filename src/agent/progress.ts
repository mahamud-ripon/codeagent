import type { TestRecord, ToolCallRecord } from "./types.js";

/**
 * No-progress detector (AG-11 remainder).
 *
 * The identical-call counter in the agent loop catches exact repeats, but a
 * run can also stall without repeating itself: every call fails with a
 * different error, or reads/searches accumulate while nothing is ever
 * written, tested, or fixed. This detector watches those shapes and hands
 * back a graceful "stuck" report instead of burning the iteration budget.
 */

export interface ProgressSnapshot {
  toolCalls: ToolCallRecord[];
  testResults: TestRecord[];
  errors: string[];
  modifiedFilesCount: number;
  /** Phase 2 hygiene: when true, empty node/python one-liner success is not durable. */
  hygieneOn?: boolean;
}

export interface ProgressVerdict {
  stalled: boolean;
  /** Human-readable reason, suitable for the stuck hand-back message. */
  reason?: string;
}

/** Consecutive failures that prove the current approach is not working. */
const CONSECUTIVE_ERROR_LIMIT = 4;
/** Calls without any durable effect before the run is considered spinning. */
const SPIN_CALL_LIMIT = 8;
/** Errors alongside zero durable effects that confirm the spin. */
const SPIN_ERROR_LIMIT = 3;

const WRITE_TOOLS = new Set(["write_file", "edit_file", "multi_edit"]);

function isEmptyInlineSuccessForProgress(cmd: string, preview: string): boolean {
  const base = cmd.trim().split(/\s+/)[0]?.split(/[\\/]/).pop()?.replace(/\.(exe|cmd|bat)$/i, "").toLowerCase() ?? "";
  if (base !== "node" && base !== "python" && base !== "python3") return false;
  if (!/-(e|c)\b/.test(cmd)) return false;
  const body = preview.replace(/exit code:\s*0/i, "").trim();
  return body.length === 0;
}

function isDurableCall(call: ToolCallRecord, testResults: TestRecord[], hygieneOn = false): boolean {
  if (!call.success) return false;
  if (WRITE_TOOLS.has(call.name)) return true;
  if (call.name === "run_command") {
    // A green command (test/typecheck/build pass) is forward motion —
    // except an empty node/python one-liner under hygiene (false green).
    const green = testResults.some((t) => t.exitCode === 0);
    if (!green) return false;
    if (hygieneOn) {
      const cmd = String(call.args?.command ?? "");
      const last = [...testResults].reverse().find((t) => t.exitCode === 0);
      if (cmd && last && isEmptyInlineSuccessForProgress(cmd, last.outputPreview)) return false;
    }
    return true;
  }
  return false;
}

/** Index of the most recent call with a durable effect, or -1. */
function lastDurableIndex(calls: ToolCallRecord[], testResults: TestRecord[], hygieneOn = false): number {
  for (let i = calls.length - 1; i >= 0; i--) {
    if (isDurableCall(calls[i]!, testResults, hygieneOn)) return i;
  }
  return -1;
}

export function detectNoProgress(snapshot: ProgressSnapshot): ProgressVerdict {
  const { toolCalls, testResults, errors, modifiedFilesCount, hygieneOn = false } = snapshot;

  // 1. Every recent call failed: the approach is broken, not the args.
  if (toolCalls.length >= CONSECUTIVE_ERROR_LIMIT) {
    const tail = toolCalls.slice(-CONSECUTIVE_ERROR_LIMIT);
    if (tail.every((call) => !call.success)) {
      const names = [...new Set(tail.map((call) => call.name))].join(", ");
      return {
        stalled: true,
        reason:
          `No progress: the last ${CONSECUTIVE_ERROR_LIMIT} tool calls all failed (${names}). ` +
          `Recent errors: ${errors.slice(-3).join(" | ") || "(none recorded)"}`,
      };
    }
  }

  // 2. Long spin with no durable effect: reads/searches (or failing writes)
  // pile up while no file is modified and no command passes. Requires
  // recent failures so pure successful exploration (inquiry tasks) never
  // trips it — succeeding reads are progress, not spinning.
  const durableIdx = lastDurableIndex(toolCalls, testResults, hygieneOn);
  const callsSinceDurable = durableIdx === -1 ? toolCalls.length : toolCalls.length - 1 - durableIdx;
  const window = toolCalls.slice(-SPIN_CALL_LIMIT);
  const recentFailures = window.filter((call) => !call.success).length;
  if (
    callsSinceDurable >= SPIN_CALL_LIMIT &&
    modifiedFilesCount === 0 &&
    !testResults.some((t) => t.exitCode === 0) &&
    errors.length >= SPIN_ERROR_LIMIT &&
    recentFailures >= 2
  ) {
    const recentNames = toolCalls.slice(-SPIN_CALL_LIMIT).map((call) => call.name);
    const distinct = [...new Set(recentNames)].join(", ");
    return {
      stalled: true,
      reason:
        `No progress: ${callsSinceDurable} tool calls since the last durable effect ` +
        `(no files modified, no passing command) with ${errors.length} errors. ` +
        `Recent tools: ${distinct}.`,
    };
  }

  // 3. Edit oscillation: repeatedly rewriting the same file while errors accumulate
  const recentWrites = toolCalls.slice(-8).filter((c) => WRITE_TOOLS.has(c.name));
  const editCounts = new Map<string, number>();
  for (const c of recentWrites) {
    const p = String(c.args?.path || "");
    if (p) editCounts.set(p, (editCounts.get(p) ?? 0) + 1);
  }
  for (const [p, count] of editCounts) {
    if (count >= 3 && errors.length >= 2) {
      return {
        stalled: true,
        reason: `Repeated modifications to '${p}' (${count} times) without resolving errors. Stopping so this run can be resumed with a different approach.`,
      };
    }
  }

  return { stalled: false };
}

/**
 * Phase 4A progressRedirect: same command twice with unchanged outcome, or
 * the same failure text with no successful write since — block that call,
 * attach the last evidence, ask for a new hypothesis. Existing abort at 6
 * identical calls stays as the backstop. Inquiry intent is exempt (Q&A can
 * reread). Fires at 2 identical commands (earlier than the warn-at-3 guard).
 */
export interface RedirectSnapshot {
  name: string;
  args: Record<string, unknown>;
  toolCalls: ToolCallRecord[];
  testResults: TestRecord[];
  errors: string[];
  intent?: string;
  lastOutput: string;
}

export function shouldRedirectProgress(snap: RedirectSnapshot): { redirect: boolean; reason?: string } {
  if (snap.intent === "inquiry" || snap.intent === "conversational" || snap.intent === "external") return { redirect: false };
  const sig = `${snap.name}:${JSON.stringify(snap.args)}`;
  const recent = snap.toolCalls.slice(-4).map((c) => `${c.name}:${JSON.stringify(c.args)}`);
  const sameCount = recent.filter((s) => s === sig).length;
  // Same exact call twice with no successful write since -> redirect once.
  if (sameCount >= 1 && snap.name === "run_command") {
    const lastWriteIdx = (() => {
      for (let i = snap.toolCalls.length - 1; i >= 0; i--) {
        const c = snap.toolCalls[i]!;
        if ((c.name === "write_file" || c.name === "edit_file" || c.name === "multi_edit") && c.success) return i;
      }
      return -1;
    })();
    const callsSinceWrite = snap.toolCalls.length - 1 - lastWriteIdx;
    if (callsSinceWrite >= 1 && sameCount >= 1) {
      // Require the failure text to match (same evidence) to avoid blocking
      // a legitimate retry after the tree changed.
      const lastErr = snap.errors.slice(-1)[0] ?? "";
      if (lastErr && snap.lastOutput.includes(lastErr.slice(0, 80))) {
        return {
          redirect: true,
          reason:
            `progressRedirect: identical run_command repeated with no successful write since ` +
            `(last error: ${lastErr.slice(0, 200)}). Propose a new hypothesis instead of retrying.`,
        };
      }
      if (sameCount >= 2) {
        return {
          redirect: true,
          reason: `progressRedirect: same command twice with unchanged outcome. Attach last evidence and try a different approach.`,
        };
      }
    }
  }
  return { redirect: false };
}
