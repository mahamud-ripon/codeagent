import type { AgentConfig } from "../agent/types.js";
import type { Responder } from "../llm/client.js";
import type { PermissionManager } from "../agent/permissions.js";
import type { AgentReporter } from "../cli/ui/reporter.js";
import type { AgentEvent } from "../llm/events.js";
import type { TodoManager } from "../agent/todo.js";
import type { PlanModeManager } from "../agent/planMode.js";
import type { FileStateCache } from "../tools/fileStateCache.js";
import type { ModelRoles } from "../llm/modelRouting.js";

export interface AgentOptions extends AgentConfig {
  /** Injected for tests — defaults to the provider selected from env. */
  responder?: Responder;
  /** Optional verbose logging (default true). */
  verbose?: boolean;
  /** Injectable clock for tests (default: real setTimeout). Abort-aware. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Permission manager for commands and destructive actions. */
  permissions?: PermissionManager;
  /** Optional visual progress reporter (spinners, tool cards). */
  reporter?: AgentReporter;
  /**
   * Plan-mode approver (AG-9): shows exit_plan_mode plans and requires
   * accept / edit / reject. A returned string is the user-revised plan.
   */
  planApprover?: (plan: string) => Promise<boolean | string>;
  /** Dynamic task/todo manager. */
  todoManager?: TodoManager;
  /** Plan mode state manager. */
  planModeManager?: PlanModeManager;
  /** File snapshot & drift cache. */
  fileStateCache?: FileStateCache;
  /** When true, mutating tools run without asking. Default is ask / fail closed. */
  autoApprove?: boolean;
  provider?: string;
  baseURL?: string;
  onEvent?: (event: AgentEvent) => void;
  contextWindow?: number;
  maxTotalTokens?: number;
  maxCostUsd?: number;
  /**
   * Fast-model responder used for LLM-written compaction summaries (AG-6).
   * When absent, the heuristic summary is used. Never throws: failures fall
   * back to the heuristic path.
   */
  summarizer?: Responder;
  /** Per-settings capability overrides (ML-3): window and output caps. */
  capabilitiesOverride?: { contextWindow?: number; maxOutput?: number };
  /**
   * Streaming provider (ML-1). When present, the loop streams text/thinking
   * deltas incrementally via onEvent instead of emitting one bulk text_delta
   * after the full reply. Responder remains the fallback so tests keep passing.
   */
  providerInstance?: import("../llm/stream.js").Provider;
  /** System prompt override (modular/versioned prompts, small-model mode). */
  systemPrompt?: string;
  /** User hooks config (EX-3): PreToolUse/PostToolUse/Stop/PreCompact. */
  hooks?: import("../agent/hooks.js").HookConfig;
  /** Model roles (ML-5): main/fast/plan for per-mode routing. */
  modelRoles?: ModelRoles;
  /**
   * Per-agent command runner + sandbox mode (Claude Code parity: no global
   * race when concurrent runs use different modes). Falls back to the
   * global active runner when absent (tests/legacy callers).
   */
  commandRunner?: import("../tools/runner.js").CommandRunner;
  sandboxMode?: "local" | "docker";
  /** Plan-model responder: used for the main loop while plan mode is active. */
  planResponder?: Responder;
  /** Force small-model mode regardless of model id (ML-4 setting). */
  smallModel?: boolean;
  /** Thin-runtime behavioral flags (plan.md Phase 2+4). Default off = baseline. */
  flags?: import("../agent/runtimeFlags.js").RuntimeFlags;
  /** Fast-model responder for Phase 4E fastExplore (read-only turns). */
  fastResponder?: Responder;
}

export class StuckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StuckError";
  }
}

export interface RunOpts {
  signal?: AbortSignal;
  history?: unknown[];
}
