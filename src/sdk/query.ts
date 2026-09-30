import { Agent } from "../agent/agent.js";
import { PermissionManager } from "../agent/permissions.js";
import type { AgentEvent } from "../llm/events.js";

/**
 * HL-4: @codeagent/core SDK — query() async iterator yielding AgentEvents.
 * Headless consumers (CI, IDE bridges) get the same stream the TUI consumes.
 */

export interface QueryOptions {
  repoRoot: string;
  model?: string;
  maxIterations?: number;
  signal?: AbortSignal;
  autoApprove?: boolean;
  allowedTools?: string[];
  resumeHistory?: unknown[];
}

export async function* query(task: string, opts: QueryOptions): AsyncGenerator<AgentEvent, { finalMessage: string }, void> {
  const queue: AgentEvent[] = [];
  let done = false;
  let result: { finalMessage: string } = { finalMessage: "" };
  const permissions = new PermissionManager({
    autoApprove: opts.autoApprove ?? false,
    allow: opts.allowedTools ?? [],
  });
  const agent = new Agent({
    repoRoot: opts.repoRoot,
    model: opts.model ?? "gpt-5.6-luna",
    maxIterations: opts.maxIterations ?? 30,
    permissions,
    autoApprove: opts.autoApprove ?? false,
    onEvent: (e) => { queue.push(e); },
  });
  const run = agent.run(task, { signal: opts.signal, history: opts.resumeHistory }).then((r) => {
    result = r;
    done = true;
    queue.push({ type: "done", result: r });
  }).catch((e: unknown) => {
    done = true;
    queue.push({ type: "error", message: e instanceof Error ? e.message : String(e), retryable: false });
  });
  let idx = 0;
  while (!done || idx < queue.length) {
    if (idx < queue.length) yield queue[idx++]!;
    else await new Promise<void>((r) => setTimeout(r, 10));
  }
  await run;
  return result;
}
