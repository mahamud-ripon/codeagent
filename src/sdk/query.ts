import { Agent } from "../agent/agent.js";
import { PermissionManager } from "../agent/permissions.js";
import { loadHooksSettings, loadModelSettings } from "../agent/settings.js";
import { createProviderFromEnv } from "../llm/provider.js";
import { resolveRoles } from "../llm/modelRouting.js";
import type { AgentEvent } from "../llm/events.js";
import type { RuntimeFlags } from "../agent/runtimeFlags.js";

/**
 * HL-4: @codeagent/core SDK — query() async iterator yielding AgentEvents.
 * Headless consumers (CI, IDE bridges) get the same stream the TUI consumes.
 */

export interface QueryOptions {
  repoRoot: string;
  model?: string;
  provider?: string;
  baseURL?: string;
  maxIterations?: number;
  signal?: AbortSignal;
  autoApprove?: boolean;
  allowedTools?: string[];
  resumeHistory?: unknown[];
  /** Thin-runtime flags (eval ablation rows). Default off = baseline. */
  flags?: RuntimeFlags;
}

export async function* query(task: string, opts: QueryOptions): AsyncGenerator<AgentEvent, { finalMessage: string }, void> {
  const queue: AgentEvent[] = [];
  let done = false;
  let result: { finalMessage: string } = { finalMessage: "" };
  const permissions = new PermissionManager({
    autoApprove: opts.autoApprove ?? false,
    allow: opts.allowedTools ?? [],
  });
  // HL-4 wiring: same provider/roles/hooks path as the CLI (streaming by default).
  const { responder, info, providerInstance, systemPrompt } = createProviderFromEnv(process.env, {
    model: opts.model,
    provider: opts.provider,
    baseURL: opts.baseURL,
  });
  const modelSettings = loadModelSettings(opts.repoRoot);
  const roles = resolveRoles(modelSettings, info.model);
  const hooks = loadHooksSettings(opts.repoRoot);
  const agent = new Agent({
    repoRoot: opts.repoRoot,
    model: info.model,
    maxIterations: opts.maxIterations ?? 30,
    responder,
    providerInstance,
    systemPrompt,
    permissions,
    provider: opts.provider,
    baseURL: opts.baseURL,
    autoApprove: opts.autoApprove ?? false,
    modelRoles: roles,
    flags: opts.flags,
    smallModel: modelSettings.smallModel,
    capabilitiesOverride: modelSettings.capabilities,
    hooks,
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
