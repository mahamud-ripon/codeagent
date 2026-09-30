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

function isDurableCall(call: ToolCallRecord, testResults: TestRecord[]): boolean {
  if (!call.success) return false;
  if (WRITE_TOOLS.has(call.name)) return true;
  if (call.name === "run_command") {
    // A green command (test/typecheck/build pass) is forward motion.
    return testResults.some((t) => t.exitCode === 0);
  }
  return false;
}

/** Index of the most recent call with a durable effect, or -1. */
function lastDurableIndex(calls: ToolCallRecord[], testResults: TestRecord[]): number {
  for (let i = calls.length - 1; i >= 0; i--) {
    if (isDurableCall(calls[i]!, testResults)) return i;
  }
  return -1;
}

export function detectNoProgress(snapshot: ProgressSnapshot): ProgressVerdict {
  const { toolCalls, testResults, errors, modifiedFilesCount } = snapshot;

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
  const durableIdx = lastDurableIndex(toolCalls, testResults);
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

  return { stalled: false };
}
