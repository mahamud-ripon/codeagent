import { truncate } from "../utils/truncate.js";

export interface CompactorOptions {
  /** Number of most recent tool outputs to keep uncompressed (default: 6). */
  keepRecentToolOutputs?: number;
  /** Max estimated total characters across all messages before dialogue rollup (default: 28,000 chars ~ 7,000 tokens). */
  maxTotalChars?: number;
  /** Force aggressive micro-compaction of tool outputs (e.g. on 413 error). */
  aggressive?: boolean;
  /** If true, prune tool outputs only and never touch conversation dialogue. */
  pruneToolsOnly?: boolean;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
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

    if (aggressive) {
      item.output = `[Output of ${toolName}${detail} (${lines} lines, ${chars} chars) pruned for brevity]`;
    } else if (chars > 400) {
      const preview = truncate(rawOutput, 250);
      item.output = `${preview}\n[...output of ${toolName}${detail} (${lines} lines, ${chars} chars) pruned to save context]`;
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
    if (result.length > 8) {
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

      const summaryText = userTopics.length > 0
        ? `[Earlier turns compacted. Key topics discussed: ${userTopics.join("; ")}]`
        : `[Earlier turns compacted to fit token limit.]`;

      const compactedSummary = {
        role: "user",
        content: summaryText,
      };

      const recent = result.slice(splitIdx);
      const assembled: unknown[] = [anchor, compactedSummary];

      // If the latest user task prompt was before splitIdx, preserve it so the agent knows its active goal
      if (lastUserMsg && lastUserIdx < splitIdx && lastUserMsg !== anchor) {
        assembled.push(lastUserMsg);
      }

      for (const item of recent) {
        if (item !== anchor && item !== lastUserMsg) {
          assembled.push(item);
        }
      }

      return assembled;
    }
  }

  return result;
}

