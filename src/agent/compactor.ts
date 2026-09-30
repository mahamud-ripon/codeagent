import { truncate } from "../utils/truncate.js";
import type { Responder } from "../llm/client.js";

/**
 * Standard Claude Code micro-compaction replacement string:
 * When tool results get old or large, instead of blowing up the context window
 * or breaking the message history chain, the bulky body is replaced with this marker.
 */
export const OLD_TOOL_RESULT_CLEARED = "[Old tool result content cleared]";
export const TIME_BASED_MC_CLEARED_MESSAGE = OLD_TOOL_RESULT_CLEARED;

export interface CompactorOptions {
  /** Number of most recent tool outputs to keep uncompressed (default: 6). */
  keepRecentToolOutputs?: number;
  /**
   * Token budget for the *kept* recent tool outputs (AG-6). When set, the
   * oldest kept outputs are pruned first until the kept total fits, so
   * recent context is bounded by tokens rather than by a fixed count.
   */
  keepRecentToolOutputTokens?: number;
  /** Max estimated total characters across all messages before dialogue rollup (default: 28,000 chars ~ 7,000 tokens). */
  maxTotalChars?: number;
  /** Force aggressive micro-compaction of tool outputs (e.g. on 413 error). */
  aggressive?: boolean;
  /** If true, prune tool outputs only and never touch conversation dialogue. */
  pruneToolsOnly?: boolean;
  /** If true, uses Claude Code's exact [Old tool result content cleared] marker. */
  useClearedMarker?: boolean;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function estimateHistoryChars(input: unknown[]): number {
  if (!input) return 0;
  return input.reduce((acc: number, item: unknown) => acc + estimateSize(item), 0);
}

/**
 * Token estimate for a single string. ~4 chars/token holds for English and
 * code; the floor keeps empty pings from vanishing from budgets.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

/** Token estimate for a history item, including per-message overhead. */
export function estimateItemTokens(item: unknown): number {
  if (!isRecord(item)) return 1;
  let total = 4; // role/type/call_id framing overhead
  if (typeof item.content === "string") total += estimateTokens(item.content);
  if (typeof item.output === "string") total += estimateTokens(item.output);
  if (typeof item.arguments === "string") total += estimateTokens(item.arguments);
  return total;
}

export function estimateHistoryTokens(input: unknown[]): number {
  if (!input) return 0;
  return input.reduce((acc: number, item: unknown) => acc + estimateItemTokens(item), 0);
}

/**
 * Compact only when history crosses a fraction of the model window.
 * Callers should not invoke compactHistory on every iteration.
 * Uses token estimates (with per-message overhead), not raw chars.
 */
export function shouldCompactHistory(
  input: unknown[],
  contextWindowTokens: number,
  ratio = 0.78,
): boolean {
  if (!input || input.length === 0) return false;
  if (!Number.isFinite(contextWindowTokens) || contextWindowTokens <= 0) return false;
  const tokens = estimateHistoryTokens(input);
  return tokens >= Math.floor(contextWindowTokens * ratio);
}

function estimateSize(item: unknown): number {
  if (!isRecord(item)) return 0;
  let total = 0;
  if (typeof item.content === "string") total += item.content.length;
  if (typeof item.output === "string") total += item.output.length;
  if (typeof item.arguments === "string") total += item.arguments.length;
  return total;
}

/**
 * Replaces older bulky tool outputs with Claude Code's standard:
 * `[Old tool result content cleared]`
 * preserving the tool calls, function call ids, and arguments.
 */
export function microCompactToolResults(
  input: unknown[],
  options?: { keepRecent?: number; placeholder?: string },
): unknown[] {
  if (!input || input.length <= 2) return input;
  const keepRecent = options?.keepRecent ?? 4;
  const placeholder = options?.placeholder ?? OLD_TOOL_RESULT_CLEARED;

  const result: unknown[] = input.map((item) => (isRecord(item) ? { ...item } : item));
  const toolOutputIndices: number[] = [];

  for (let i = 0; i < result.length; i++) {
    const item = result[i];
    if (isRecord(item) && item.type === "function_call_output") {
      toolOutputIndices.push(i);
    }
  }

  const pruneCount = Math.max(0, toolOutputIndices.length - keepRecent);
  for (let k = 0; k < pruneCount; k++) {
    const idx = toolOutputIndices[k];
    const item = result[idx] as Record<string, unknown>;
    item.output = placeholder;
  }

  return result;
}

/**
 * Compacts conversation history using industry-standard tiered compaction:
 * 1. Tier 1: Micro-prunes older tool outputs (which account for 90-95% of tokens),
 *    condensing them into lightweight, informative stubs while preserving full recent outputs.
 * 2. Conversational dialogue (user questions & assistant answers) is strictly preserved
 *    as long as the session fits in the character/token budget.
 * 3. Tier 2: If conversation dialogue alone exceeds maxTotalChars, generates an informative
 *    topic summary of earlier turns, preserving essential repository context and the active user task.
 */
export function compactHistory(
  input: unknown[],
  options?: CompactorOptions,
): unknown[] {
  if (!input || input.length <= 2) return input;

  const keepRecent = options?.keepRecentToolOutputs ?? 6;
  const maxTotalChars = options?.maxTotalChars ?? 28_000;
  const aggressive = options?.aggressive ?? false;
  const pruneToolsOnly = options?.pruneToolsOnly ?? false;

  // Clone array and items we modify
  const result: unknown[] = input.map((item) => (isRecord(item) ? { ...item } : item));
  // Build a lookup map of call_id -> tool call info to create informative stubs
  const toolCallMap = new Map<string, { name: string; args: string }>();
  for (const item of result) {
    if (isRecord(item) && item.type === "function_call" && typeof item.call_id === "string") {
      toolCallMap.set(item.call_id, {
        name: String(item.name ?? "tool"),
        args: typeof item.arguments === "string" ? item.arguments : "",
      });
    }
  }

  // 1. Identify all function_call_output indices
  const toolOutputIndices: number[] = [];
  for (let i = 0; i < result.length; i++) {
    const item = result[i];
    if (isRecord(item) && item.type === "function_call_output") {
      toolOutputIndices.push(i);
    }
  }

  // Micro-prune older tool outputs (leave only the last `keepRecent` outputs intact)
  const pruneCount = Math.max(0, toolOutputIndices.length - keepRecent);
  for (let k = 0; k < pruneCount; k++) {
    const idx = toolOutputIndices[k];
    const item = result[idx] as Record<string, unknown>;
    const rawOutput = typeof item.output === "string" ? item.output : "";
    const callId = typeof item.call_id === "string" ? item.call_id : "";
    const callInfo = toolCallMap.get(callId);
    const toolName = callInfo?.name ?? "tool";

    let detail = "";
    if (callInfo?.args) {
      try {
        const parsed = JSON.parse(callInfo.args);
        if (typeof parsed.path === "string") detail = ` for ${parsed.path}`;
        else if (typeof parsed.command === "string") detail = `: ${parsed.command}`;
      } catch {
        // ignore
      }
    }

    const lines = rawOutput.split("\n").length;
    const chars = rawOutput.length;

    if (options?.useClearedMarker) {
      item.output = OLD_TOOL_RESULT_CLEARED;
    } else if (aggressive) {
      item.output = `[Output of ${toolName}${detail} (${lines} lines, ${chars} chars) pruned for brevity]`;
    } else if (chars > 400) {
      const preview = truncate(rawOutput, 250);
      item.output = `${preview}\n[...output of ${toolName}${detail} (${lines} lines, ${chars} chars) pruned to save context]`;
    }
  }

  // 1b. Keep recent outputs by *tokens*: prune the oldest kept outputs
  // until the kept window fits the token budget (at least one survives).
  const keepTokens = options?.keepRecentToolOutputTokens;
  if (keepTokens !== undefined && toolOutputIndices.length > 0) {
    const keptIdx = toolOutputIndices.slice(Math.max(0, toolOutputIndices.length - keepRecent));
    let keptTokens = keptIdx.reduce((acc, idx) => {
      const item = result[idx] as Record<string, unknown>;
      return acc + (typeof item.output === "string" ? estimateTokens(item.output) : 0);
    }, 0);
    for (const idx of keptIdx) {
      if (keptTokens <= keepTokens) break;
      if (keptIdx[keptIdx.length - 1] === idx) break; // always keep the newest
      const item = result[idx] as Record<string, unknown>;
      const rawOutput = typeof item.output === "string" ? item.output : "";
      keptTokens -= estimateTokens(rawOutput);
      item.output = `[Output pruned to fit the recent-output token budget (${rawOutput.length} chars)]`;
    }
  }

  // 2. Calculate total character size after tool output pruning
  let currentTotalChars = result.reduce(
    (acc: number, item: unknown) => acc + estimateSize(item),
    0,
  );

  // If still oversized and aggressive or beyond budget, condense tool outputs to 1-line stubs first
  if (currentTotalChars > maxTotalChars) {
    for (let k = 0; k < pruneCount; k++) {
      const idx = toolOutputIndices[k];
      const item = result[idx] as Record<string, unknown>;
      const callId = typeof item.call_id === "string" ? item.call_id : "";
      const callInfo = toolCallMap.get(callId);
      const toolName = callInfo?.name ?? "tool";
      const rawOutput = typeof item.output === "string" ? item.output : "";
      item.output = `[Output of ${toolName} pruned (${rawOutput.length} chars)]`;
    }
    currentTotalChars = result.reduce(
      (acc: number, item: unknown) => acc + estimateSize(item),
      0,
    );
  }

  // Truncate oversized older assistant text/code listings (>800 chars) before dropping dialogue turns
  if (currentTotalChars > maxTotalChars) {
    const cutoff = Math.max(0, result.length - 4);
    for (let i = 0; i < cutoff; i++) {
      const item = result[i];
      if (isRecord(item) && (item.role === "assistant" || item.type === "message")) {
        const text = typeof item.content === "string" ? item.content : "";
        if (text.length > 800) {
          const preview = truncate(text, 350);
          item.content = `${preview}\n[...earlier assistant code listing (${text.length} chars) truncated to preserve context budget...]`;
        }
      }
    }
    currentTotalChars = result.reduce(
      (acc: number, item: unknown) => acc + estimateSize(item),
      0,
    );
  }

  // 3. Dialogue protection & sliding window: only roll up dialogue if total characters STILL exceed budget
  if (currentTotalChars > maxTotalChars && !pruneToolsOnly) {
    const split = splitDialogueForSummary(result);
    if (split) {
      return assembleCompacted(split, heuristicSummaryText(split.middleItems));
    }
  }

  return result;
}

export interface DialogueSplit {
  anchor: unknown;
  anchorIdx: number;
  splitIdx: number;
  middleItems: unknown[];
  recent: unknown[];
  lastUserMsg: Record<string, unknown> | null;
  lastUserIdx: number;
}

/**
 * Split history into a preserved anchor (system/repo context), droppable
 * middle turns, and a recent window — never severing a tool response from
 * its initiating tool call. Returns null when there is nothing to roll up.
 */
export function splitDialogueForSummary(result: unknown[]): DialogueSplit | null {
  if (!result || result.length <= 8) return null;
  // 3a. Locate essential system / repository context anchor (if present)
  let anchorIdx = result.findIndex(
    (item) =>
      isRecord(item) &&
      (item.role === "system" ||
        (typeof item.content === "string" && item.content.includes("<repository>"))),
  );
  if (anchorIdx === -1) {
    anchorIdx = 0;
  }
  const anchor = result[anchorIdx];

  // 3b. Determine the recent items window (e.g. last 6 items), ensuring safe message boundaries
  let splitIdx = Math.max(anchorIdx + 1, result.length - 6);

  // Never sever a tool response from its initiating tool call
  while (splitIdx > anchorIdx + 1) {
    const item = result[splitIdx];
    if (isRecord(item) && item.type === "function_call_output") {
      splitIdx--;
    } else {
      break;
    }
  }
  while (splitIdx > anchorIdx + 1) {
    const prev = result[splitIdx - 1];
    if (isRecord(prev) && prev.type === "function_call") {
      splitIdx--;
    } else {
      break;
    }
  }

  // 3c. Identify the most recent active user task prompt
  let lastUserMsg: Record<string, unknown> | null = null;
  let lastUserIdx = -1;
  for (let i = result.length - 1; i >= 0; i--) {
    const item = result[i];
    if (
      isRecord(item) &&
      item.role === "user" &&
      typeof item.content === "string" &&
      !item.content.startsWith("[Earlier")
    ) {
      lastUserMsg = item;
      lastUserIdx = i;
      break;
    }
  }

  // 3d. Gather middle items to summarize
  const middleItems: unknown[] = [];
  for (let i = 0; i < splitIdx; i++) {
    if (i === anchorIdx) continue;
    if (i === lastUserIdx && lastUserIdx < splitIdx) continue;
    middleItems.push(result[i]);
  }

  return { anchor, anchorIdx, splitIdx, middleItems, recent: result.slice(splitIdx), lastUserMsg, lastUserIdx };
}

/** Heuristic rollup: key user topics from pruned turns. */
export function heuristicSummaryText(middleItems: unknown[]): string {
  // Extract user topics discussed in pruned turns to retain semantic continuity
  const userTopics: string[] = [];
  for (const item of middleItems) {
    if (isRecord(item) && item.role === "user" && typeof item.content === "string") {
      const cleaned = item.content
        .replace(/<repository>[\s\S]*?<\/repository>/g, "")
        .replace(/<environment>[\s\S]*?<\/environment>/g, "")
        .replace(/<task>|<\/task>/g, "")
        .trim();
      const firstLine = cleaned.split("\n")[0]?.trim();
      if (firstLine && !userTopics.includes(firstLine) && !firstLine.startsWith("[Earlier")) {
        userTopics.push(truncate(firstLine, 80));
      }
    }
  }

  return userTopics.length > 0
    ? `[Earlier turns compacted. Key topics discussed: ${userTopics.join("; ")}]`
    : `[Earlier turns compacted to fit token limit.]`;
}

export function assembleCompacted(split: DialogueSplit, summaryText: string): unknown[] {
  const compactedSummary = {
    role: "user",
    content: summaryText,
  };

  const recent = split.recent;
  const assembled: unknown[] = [split.anchor, compactedSummary];

  // If the latest user task prompt was before splitIdx, preserve it so the agent knows its active goal
  if (split.lastUserMsg && split.lastUserIdx < split.splitIdx && split.lastUserMsg !== split.anchor) {
    assembled.push(split.lastUserMsg);
  }

  for (const item of recent) {
    if (item !== split.anchor && item !== split.lastUserMsg) {
      assembled.push(item);
    }
  }

  return assembled;
}

/** Render pruned turns as a compact transcript for a summarizer model. */
export function formatMiddleForSummary(middleItems: unknown[], maxChars = 12_000): string {
  const lines: string[] = [];
  for (const item of middleItems) {
    if (!isRecord(item)) continue;
    if (item.type === "function_call") {
      lines.push(`tool_call ${String(item.name ?? "unknown")} ${truncate(String(item.arguments ?? ""), 300)}`);
    } else if (item.type === "function_call_output") {
      lines.push(`tool_result: ${truncate(String(item.output ?? ""), 500)}`);
    } else if (typeof item.content === "string" && item.content.trim()) {
      const role = typeof item.role === "string" ? item.role : "message";
      lines.push(`${role}: ${truncate(item.content.trim(), 800)}`);
    }
  }
  return truncate(lines.join("\n"), maxChars);
}

const SUMMARY_SYSTEM =
  "Summarize the earlier part of a coding-agent session for context compaction. " +
  "Preserve: the task and its current state, decisions made, files touched with what changed, " +
  "open errors or blockers, and todo progress. Be terse (<= 20 lines). Output plain prose, no preamble.";

function extractSummaryText(result: { output_text?: string }): string | null {
  const text = result.output_text?.trim();
  return text ? text : null;
}

/**
 * Tiered compaction with an LLM-written summary (AG-6): prunes tool outputs
 * first, then asks the `fast` model to summarize the middle turns. Falls
 * back to the heuristic summary when the summarizer fails or returns
 * nothing, so compaction never throws.
 */
export async function compactHistoryWithSummary(
  input: unknown[],
  summarizer: Responder,
  options?: CompactorOptions & { focus?: string },
): Promise<unknown[]> {
  const pruned = compactHistory(input, { ...options, pruneToolsOnly: true });
  const maxTotalChars = options?.maxTotalChars ?? 28_000;
  if (estimateHistoryChars(pruned) <= maxTotalChars) return pruned;

  const split = splitDialogueForSummary(pruned);
  if (!split || split.middleItems.length === 0) return pruned;

  const focusLine = options?.focus?.trim() ? `\nPay special attention to: ${options.focus.trim()}` : "";
  const prompt =
    `The session below is being compacted to fit the context window.${focusLine}\n` +
    `<session>\n${formatMiddleForSummary(split.middleItems)}\n</session>`;
  try {
    const summary = extractSummaryText(
      await summarizer([{ role: "user", content: `${SUMMARY_SYSTEM}\n\n${prompt}` }], { tools: false }),
    );
    const text = summary ?? heuristicSummaryText(split.middleItems);
    return assembleCompacted(split, `[Earlier turns compacted by model summary. ${text}]`);
  } catch {
    return assembleCompacted(split, heuristicSummaryText(split.middleItems));
  }
}

