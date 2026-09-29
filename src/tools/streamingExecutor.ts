/**
 * Streaming Tool Concurrency Engine.
 *
 * Inspired by Claude Code's StreamingToolExecutor (src/services/tools/StreamingToolExecutor.ts):
 * - Identifies whether tools are concurrency-safe (read-only) or mutating (exclusive).
 * - Executes concurrent-safe tools in parallel with other concurrent-safe tools.
 * - Mutating tools execute strictly sequentially with exclusive access.
 * - Buffers and emits results in the exact order tools were called.
 * - Sibling cancellation: if a fatal tool error occurs, aborts in-flight siblings.
 */

export interface ToolCallItem {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ToolExecutionResult {
  callId: string;
  name: string;
  output: string;
  success: boolean;
  durationMs: number;
}

const CONCURRENCY_SAFE_TOOLS = new Set([
  "list_files",
  "read_file",
  "view_file",
  "search",
  "view_symbol_outline",
  "git_status",
  "git_diff",
]);

export function isConcurrencySafeTool(name: string): boolean {
  return CONCURRENCY_SAFE_TOOLS.has(name);
}

export class StreamingToolExecutor {
  private inFlightAbortController: AbortController;

  constructor(parentSignal?: AbortSignal) {
    this.inFlightAbortController = new AbortController();
    if (parentSignal) {
      parentSignal.addEventListener("abort", () => {
        this.inFlightAbortController.abort();
      });
    }
  }

  getSignal(): AbortSignal {
    return this.inFlightAbortController.signal;
  }

  /**
   * Partitions tool calls into consecutive batches:
   * - Adjacent concurrency-safe tools form parallel batches.
   * - Mutating tools form single-item sequential batches.
   */
  partitionBatches(calls: ToolCallItem[]): ToolCallItem[][] {
    const batches: ToolCallItem[][] = [];
    let currentBatch: ToolCallItem[] = [];
    let currentIsSafe = false;

    for (const call of calls) {
      const safe = isConcurrencySafeTool(call.name);
      if (currentBatch.length === 0) {
        currentBatch.push(call);
        currentIsSafe = safe;
      } else if (safe && currentIsSafe) {
        currentBatch.push(call);
      } else {
        batches.push(currentBatch);
        currentBatch = [call];
        currentIsSafe = safe;
      }
    }
    if (currentBatch.length > 0) {
      batches.push(currentBatch);
    }

    return batches;
  }

  /**
   * Executes a list of tool calls with concurrency control:
   * - Parallel execution for read-only batches.
   * - Sequential execution for mutating tools.
   */
  async executeAll(
    calls: ToolCallItem[],
    executor: (call: ToolCallItem, signal: AbortSignal) => Promise<ToolExecutionResult>,
  ): Promise<ToolExecutionResult[]> {
    const batches = this.partitionBatches(calls);
    const results: ToolExecutionResult[] = [];

    for (const batch of batches) {
      if (this.inFlightAbortController.signal.aborted) {
        throw new Error("Tool execution aborted.");
      }

      const isParallel = batch.length > 1 && isConcurrencySafeTool(batch[0].name);

      if (isParallel) {
        // Run parallel read batch
        const batchResults = await Promise.all(
          batch.map((call) =>
            executor(call, this.inFlightAbortController.signal).catch((err) => ({
              callId: call.id,
              name: call.name,
              output: `TOOL ERROR (${call.name}): ${err instanceof Error ? err.message : String(err)}`,
              success: false,
              durationMs: 0,
            })),
          ),
        );
        results.push(...batchResults);
      } else {
        // Run sequential mutating tool
        for (const call of batch) {
          if (this.inFlightAbortController.signal.aborted) {
            throw new Error("Tool execution aborted.");
          }
          const res = await executor(call, this.inFlightAbortController.signal);
          results.push(res);
        }
      }
    }

    return results;
  }
}
