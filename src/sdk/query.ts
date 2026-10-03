import { RuntimeClient, type RunHandle } from "../runtime/client.js";
import type { SessionOptions } from "../runtime/supervisor.js";
export interface QueryOptions extends SessionOptions {
  repoRoot: string;
  sessionId?: string;
  runtimeHome?: string;
  signal?: AbortSignal;
}
/** A durable run handle. Disconnecting the caller does not cancel the run. */
export async function query(
  task: string,
  opts: QueryOptions,
): Promise<RunHandle> {
  const client = new RuntimeClient(opts.runtimeHome);
  const session =
    opts.sessionId ?? (await client.create(opts.repoRoot, opts)).id;
  const handle = await client.submit(session, task);
  if (opts.signal) {
    const cancel = () => {
      void handle.cancel().catch(() => {});
    };
    if (opts.signal.aborted) cancel();
    else opts.signal.addEventListener("abort", cancel, { once: true });
  }
  return handle;
}
export { RuntimeClient, RunHandle } from "../runtime/client.js";
export type {
  RuntimeEvent,
  SessionStore,
  ToolDefinition,
  TaskRecord,
  VerificationRecord,
} from "../runtime/contracts.js";
export { AgentRuntime } from "../runtime/runtime.js";
