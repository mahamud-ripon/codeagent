import { executeTool } from "../tools/index.js";
import { buildInitialContext } from "./context.js";
import { discoverRules, loadProjectMemory } from "./rules.js";
import {
  createInitialState,
  inferPhase,
  type AgentConfig,
  type AgentRunResult,
  type AgentState,
} from "./types.js";
import { classifyIntent, fastGreetingResponse } from "./intent.js";
import { classifyIntentWithModel } from "./intentModel.js";
import { buildSystemPrompt, promptFamilyForModel } from "./promptSections.js";
import { isSmallModelMode, filterToolsForSmallModel, repairToolArgumentsJson, SMALL_MODEL_SYSTEM_SUFFIX } from "../llm/smallModel.js";
import { resolveModelFor, type ModelRoles } from "../llm/modelRouting.js";
import { loadImageBlocks, imageBlocksToHistoryItems } from "./images.js";
import type { Responder } from "../llm/client.js";
import { createProviderFromEnv } from "../llm/provider.js";
import { truncate } from "../utils/truncate.js";

import { PermissionManager } from "./permissions.js";
import { compactHistory, compactHistoryWithSummary, estimateHistoryChars, shouldCompactHistory } from "./compactor.js";
import { getQuickDiagnostics } from "./diagnostics.js";
import type { AgentReporter } from "../cli/ui/reporter.js";
import { estimateCostUsd, getModelCapabilities } from "../llm/capabilities.js";
import type { AgentEvent } from "../llm/events.js";
import type { ProviderOverrides } from "../llm/provider.js";
import type { ResponsesCreateResult } from "../llm/client.js";
import { TodoManager } from "./todo.js";
import { PlanModeManager } from "./planMode.js";
import { evaluateStopHooks } from "./stopHooks.js";
import { FileStateCache } from "../tools/fileStateCache.js";
import { isConcurrencySafeTool, StreamingToolExecutor } from "../tools/streamingExecutor.js";
import { detectNoProgress } from "./progress.js";
import { logAudit } from "./audit.js";
import { isAuthError as isAuthErrorFromRetry, isRateLimitError as isRateLimitErrorFromRetry } from "../llm/retry.js";
import { loadModelSettings } from "./settings.js";
import type { RuntimeFlags } from "./runtimeFlags.js";
import { DEFAULT_RUNTIME_FLAGS } from "./runtimeFlags.js";

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
  /** Interactive clarification supplied by a terminal or embedding UI. */
  askUser?: (question: string) => Promise<string>;
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
  hooks?: import("./hooks.js").HookConfig;
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
  flags?: import("./runtimeFlags.js").RuntimeFlags;
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

const MAX_CONSECUTIVE_API_ERRORS = 3;
const RECENT_WINDOW = 8;
const REPEAT_WARN_THRESHOLD = 3;
const REPEAT_ABORT_THRESHOLD = 6;
const MAX_TOOL_OUTPUT_CHARS = 12_000;
/** Rate-limit retries wait out the window instead of failing fast. */
const MAX_RATE_LIMIT_RETRIES = 5;
const RATE_LIMIT_BACKOFF_MS = [10_000, 20_000, 30_000, 45_000, 60_000];

export function isRateLimitError(message: string): boolean {
  return isRateLimitErrorFromRetry(message);
}

/** 401/403s never resolve by retrying — fail immediately with a fix. */
export function isAuthError(message: string): boolean {
  return isAuthErrorFromRetry(message);
}

function signatureFor(name: string, args: Record<string, unknown>): string {
  return `${name}:${JSON.stringify(args)}`;
}

function extractExitCode(output: string): number | null {
  const m = output.match(/^exit code:\s*(-?\d+)/m);
  return m ? Number(m[1]) : null;
}

export class Agent {
  private responder: Responder;
  private providerInstance?: import("../llm/stream.js").Provider;
  private systemPrompt: string;
  private verbose: boolean;
  private permissions: PermissionManager;
  private reporter?: AgentReporter;
  private todoManager: TodoManager;
  private planModeManager: PlanModeManager;
  private fileStateCache: FileStateCache;
  private providerOverrides: ProviderOverrides;
  private usage = { input: 0, output: 0, costUsd: 0, cachedInput: 0 };
  /** Retries inside withProviderRetry for the most recent model call (per-turn). */
  private lastCallProviderRetries = 0;
  private modelRoles?: ModelRoles;
  private planResponder?: Responder;
  private smallModelForced?: boolean;
  private flags: RuntimeFlags;
  private fastResponder?: Responder;

  constructor(private options: AgentOptions) {
    this.verbose = options.verbose ?? true;
    this.providerOverrides = {
      model: options.model,
      provider: options.provider,
      baseURL: options.baseURL,
    };
    const providerResult = createProviderFromEnv(process.env, this.providerOverrides);
    this.responder =
      options.responder ??
      providerResult.responder;
    this.providerInstance = options.providerInstance ?? (options.responder ? undefined : providerResult.providerInstance);
    // AG-2: default to the versioned family prompt for the active model;
    // ML-4: small models get the short prompt + suffix.
    const small = options.smallModel ?? (() => {
      try { return isSmallModelMode(options.model, loadModelSettings(options.repoRoot)); } catch { return false; }
    })();
    const family = promptFamilyForModel(options.model);
    const basePrompt = (() => {
      try {
        return buildSystemPrompt({ family, small });
      } catch {
        return options.systemPrompt ?? "";
      }
    })();
    this.systemPrompt = options.systemPrompt ?? `${basePrompt}${small && !basePrompt.includes("SMALL-MODEL") ? `\n${SMALL_MODEL_SYSTEM_SUFFIX}` : ""}`;
    this.permissions = options.permissions ?? new PermissionManager({ autoApprove: options.autoApprove ?? false });
    this.reporter = options.reporter;
    this.todoManager = options.todoManager ?? new TodoManager();
    this.planModeManager = options.planModeManager ?? new PlanModeManager();
    this.fileStateCache = options.fileStateCache ?? new FileStateCache();
    this.modelRoles = options.modelRoles;
    this.planResponder = options.planResponder;
    this.smallModelForced = options.smallModel;
    this.flags = options.flags ?? { ...DEFAULT_RUNTIME_FLAGS };
    this.fastResponder = options.fastResponder;
  }

  private emit(event: AgentEvent): void {
    this.options.onEvent?.(event);
  }

  /**
   * ML-1 streaming call shape: when a Provider is injected, forward its
   * text/thinking deltas to onEvent as they arrive, then collapse to the
   * legacy result the loop already understands. Otherwise use Responder.
   * ML-5: while plan mode is active and a plan-model responder is
   * configured, route the main-loop call through it (resolveModelFor).
   */
  private async callModel(
    input: unknown[],
    opts?: { tools?: boolean; signal?: AbortSignal; phase?: string; exclude?: string[] },
  ): Promise<ResponsesCreateResult> {
    // ML-5 plan-role routing: exploration while planning prefers the plan model.
    const usePlanResponder = this.planModeManager?.isActive() && this.planResponder;
    if (usePlanResponder) {
      try {
        void resolveModelFor("read", { main: this.options.model, plan: this.modelRoles?.plan });
        return await this.planResponder!(input, opts);
      } catch {
        // fall through to the default path
      }
    }
    // Phase 4E fastExplore: read-only explore turns may use settings.fast when
    // it differs from main. Edits stay on main. Gated on Phase 1 latency data
    // (high genMsPerToken with few output tokens, not queue/retries).
    if (this.flags.fastExplore && opts?.phase === "explore" && this.fastResponder) {
      try {
        return await this.fastResponder(input, opts);
      } catch {
        // fall through to main on fast-model failure
      }
    }
    if (!this.providerInstance) {
      // Small-model JSON repair happens at the tool-arg layer; the model
      // call itself stays identical so tests keep passing.
      return this.responder(input, opts);
    }
    const { collectStreamingWithEmit } = await import("../llm/collectStream.js");
    const { withProviderRetry } = await import("../llm/retry.js");
    // Single retry layer for whole-stream failures (mid-stream truncation,
    // empty stream). Provider adapters retry only the initial fetch POST
    // (maxAttempts 2); this outer layer retries the collapsed stream.
    // Total bounded at 2×3=6 attempts, Retry-After honored up to 5m.
    this.lastCallProviderRetries = 0;
    try {
      return await withProviderRetry(
        () =>
          collectStreamingWithEmit(
            this.providerInstance!,
            { system: this.systemPrompt ?? "", messages: input, tools: opts?.tools ?? true, signal: opts?.signal, exclude: opts?.exclude },
            (e) => this.emit(e),
          ),
        {
          signal: opts?.signal,
          maxAttempts: 3,
          baseMs: 1500,
          maxMs: 15_000,
          onRetry: (attempt, waitMs, msg) => {
            this.lastCallProviderRetries += 1;
            this.log(`Streaming provider retry ${attempt} after error (${msg}), waiting ${waitMs}ms...`);
          },
        },
      );
    } catch (e) {
      // A failed model call still consumed retries (and possibly queue/time).
      // Emit them so per-turn JSONL does not silently drop them; token counts
      // stay 0 because no usage chunk was received.
      if (this.lastCallProviderRetries > 0) {
        try {
          this.emit({
            type: "usage",
            input: 0,
            output: 0,
            reasoningTokens: null,
            usageEstimated: true,
            providerRetries: this.lastCallProviderRetries,
          });
        } catch {
          // timing/emit must never break the error path
        }
        this.lastCallProviderRetries = 0;
      }
      throw e;
    }
  }

  getTodoManager(): TodoManager {
    return this.todoManager;
  }

  getPlanModeManager(): PlanModeManager {
    return this.planModeManager;
  }

  getFileStateCache(): FileStateCache {
    return this.fileStateCache;
  }

  private log(...args: unknown[]): void {
    if (this.verbose) console.log(...args);
  }

  private checkCancelled(signal?: AbortSignal): void {
    if (signal?.aborted) {
      throw new Error("Agent run cancelled by user (AbortSignal).");
    }
  }

  async run(userRequest: string, runOpts?: RunOpts): Promise<AgentRunResult> {
    const signal = runOpts?.signal;
    const { repoRoot, maxIterations } = this.options;
    const state: AgentState = createInitialState(userRequest);
    // AG-2: regex is the sync default; a fast-model second opinion refines
    // ambiguous prompts without ever throwing (falls back to regex).
    let intent = classifyIntent(userRequest);
    try {
      if (this.options.summarizer) {
        intent = await classifyIntentWithModel(userRequest, this.options.summarizer);
      }
    } catch {
      intent = classifyIntent(userRequest);
    }
    // EX-3: UserPromptSubmit hooks fire best-effort before the turn.
    if (this.options.hooks?.UserPromptSubmit) {
      try {
        const { runHooks } = await import("./hooks.js");
        await runHooks(this.options.hooks, "UserPromptSubmit", { prompt: userRequest.slice(0, 4000) });
      } catch {
        // never block
      }
    }

    try {
      // Fast path: exact greetings/thanks/bye skip the model entirely (~0ms,
      // fixes 5s+ latency on "hello" reported in manual tests).
      const fast = fastGreetingResponse(userRequest);
      if (fast !== null) {
        const input: unknown[] = runOpts?.history && runOpts.history.length > 0
          ? [...runOpts.history]
          : [];
        input.push({ role: "user", content: userRequest });
        input.push({ role: "assistant", content: fast });
        this.reporter?.stop();
        return {
          finalMessage: fast,
          iterations: 0,
          modifiedFiles: [],
          testResults: [],
          history: input,
          intent: "conversational",
        };
      }

      // External/current-info path: needs web_search capability.
      // No repo map, no rules, no git review. Explicit limitation when
      // web is unavailable instead of answering from stale knowledge.
      if (intent === "external") {
        const webAvailable = Boolean(process.env.TAVILY_API_KEY?.trim() || process.env.WEB_SEARCH_ENDPOINT?.trim());
        if (!webAvailable) {
          const input: unknown[] = runOpts?.history && runOpts.history.length > 0
            ? [...runOpts.history]
            : [];
          input.push({ role: "user", content: userRequest });
          const msg =
            `Web access is unavailable in this environment (no \`TAVILY_API_KEY\` or \`WEB_SEARCH_ENDPOINT\` configured), ` +
            `so I cannot verify current/external information such as the latest model releases, ` +
            `prices, or live docs.\n\n` +
            `I can help with your repository, explain general concepts from background knowledge ` +
            `(clearly labeled as unverified for current facts), or retry once web search is configured.`;
          input.push({ role: "assistant", content: msg });
          this.reporter?.stop();
          return {
            finalMessage: msg,
            iterations: 0,
            modifiedFiles: [],
            testResults: [],
            history: input,
            intent,
          };
        }
        // Web available: answer with web tools only, no repo context.
        // Fall through to the main loop but flag no-repo-context below.
      }

      // Conversational bypass: If user prompt is a greeting or general help question,
      // respond directly without running any tools or shell commands.
      if (intent === "conversational") {
        const input: unknown[] = runOpts?.history && runOpts.history.length > 0
          ? [...runOpts.history]
          : [];
        input.push({ role: "user", content: userRequest });

        if (this.reporter) {
          this.reporter.onIterationStart(1, 1, "chat");
        } else {
          this.log(`\n--- conversational [direct response] ---`);
        }
        this.checkCancelled(signal);

        const thinkingStart = Date.now();
        let result: ResponsesCreateResult;
        try {
          result = await this.callModel(input, { tools: false, signal });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.log(`Conversational callModel failed: ${msg}`);
          const fallbackText =
            `Hello! I'm **CodeAgent**, your software engineering assistant.\n\n` +
            `⚠️ Note: The upstream AI model reported high traffic or temporary overload (${msg}).\n` +
            `You can retry in a moment, or switch to a high-capacity model (e.g. \`llama-3.3-70b-versatile\` or \`gpt-4o\`).`;
          this.reporter?.stop();
          return {
            finalMessage: fallbackText,
            iterations: 1,
            modifiedFiles: [],
            testResults: [],
            history: input,
            intent,
          };
        }
        const thinkingDurationMs = Date.now() - thinkingStart;
        if (result.reasoning_text?.trim() && this.reporter?.onThinking) {
          this.reporter.onThinking(result.reasoning_text.trim(), thinkingDurationMs);
        }
        for (const item of result.output) input.push(item);
        const text = result.output_text?.trim() || "Hello! What would you like to work on?";
        if (!result.output.some((item) => (item as { content?: string }).content || (item as { text?: string }).text)) {
          input.push({ role: "assistant", content: text });
        }

        this.reporter?.stop();
        return {
          finalMessage: text,
          iterations: 1,
          modifiedFiles: [],
          testResults: [],
          history: input,
          intent,
        };
      }

    let input: unknown[] = runOpts?.history && runOpts.history.length > 0
      ? [...runOpts.history]
      : [];

    // Ensure repository context is injected on the first non-conversational turn even after greetings.
    // External/current-info turns skip repo context entirely (no map, no rules).
    const hasRepoContext = input.some((item) => {
      if (typeof item !== "object" || item === null) return false;
      const content = (item as { content?: unknown }).content;
      return typeof content === "string" && content.includes("<repository>");
    });

    const skipRepoContext = intent === "external";
    const rules = skipRepoContext ? [] : discoverRules(repoRoot);
    const memory = skipRepoContext ? [] : loadProjectMemory(repoRoot);

    if (!hasRepoContext && !skipRepoContext) {
      // AG-16: ranked map focuses the one-shot context on the task query.
      const repoContext = await buildInitialContext(repoRoot, rules, memory, userRequest);
      input.push({
        role: "system",
        content: repoContext,
      });
    }
    input.push({
      role: "user",
      content: userRequest,
    });
    // AG-15: @image.png mentions become vision blocks for capable models.
    // Missing/unreadable images are ignored (mention text stays).
    try {
      const blocks = await loadImageBlocks(repoRoot, userRequest);
      if (blocks.length > 0) {
        for (const item of imageBlocksToHistoryItems(blocks, userRequest)) input.push(item);
      }
    } catch {
      // images are best-effort
    }



    let consecutiveApiErrors = 0;
    let rateLimitRetries = 0;
    let maxOutputTokensRecoveryCount = 0;
    let reviewed = false;
    let lastDenied = false;
    let hasPromptedFinalSummary = false;
    let noActionNudges = 0;
    let stopHookRetries = 0;
    let lastModelOutputText = "";
    // Thin-runtime (Phase 4) per-run state. All default-off; empty contract
    // means apiLock is off for this run (never invented by the runtime).
    const runStartMs = Date.now();
    let runContract: import("./contract.js").RunContract | null = null;
    const readContents = new Map<string, string>();
    let lastVerificationFailed = false;
    let lastBuildGreen = false;
    let verificationGreen = false;
    let greenNudgeSent = false;
    const tempTestFiles = new Set<string>();
    let isGitRepo: boolean | undefined;
    let sourceFileCount: number | undefined;
    // Capability-aware routing: always know git + web availability so the
    // model is never offered tools that cannot work (fixes web_search +
    // git_status hallucinations outside repos). Cheap cached checks.
    try {
      const { isGitRepo: checkGit } = await import("../tools/git.js");
      isGitRepo = await checkGit(repoRoot);
    } catch {
      isGitRepo = undefined;
    }
    if (this.flags.economy) {
      try {
        const { listFiles } = await import("../tools/filesystem.js");
        const listing = await listFiles(repoRoot, ".", this.flags.hygiene);
        sourceFileCount = listing ? listing.split("\n").filter((l) => l.trim() && !l.startsWith("[")).length : undefined;
      } catch {
        sourceFileCount = undefined;
      }
    }
    const MAX_STOP_HOOK_RETRIES = 2;
    const sleep = this.options.sleep ?? ((ms: number, sig?: AbortSignal) => {
      const signalToWatch = sig ?? signal;
      if (signalToWatch?.aborted) return Promise.reject(new Error("Agent run cancelled by user (AbortSignal)."));
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          signalToWatch?.removeEventListener("abort", onAbort);
          resolve();
        }, ms);
        const onAbort = (): void => {
          clearTimeout(timer);
          reject(new Error("Agent run cancelled by user (AbortSignal)."));
        };
        signalToWatch?.addEventListener("abort", onAbort, { once: true });
      });
    });

    for (let i = 0; i < maxIterations; i++) {
      this.checkCancelled(signal);
      state.iteration = i + 1;
      state.phase = inferPhase(state);
      if (this.reporter) {
        this.reporter.onIterationStart(state.iteration, maxIterations, state.phase);
      } else {
        this.log(`\n--- iteration ${state.iteration}/${maxIterations} [${state.phase}] ---`);
      }

      // Proactive budget guidance when approaching maxIterations
      if (state.iteration === maxIterations - 1 && maxIterations > 3) {
        input.push({
          role: "user",
          content:
            `⚠️ BUDGET WARNING: You have reached turn ${state.iteration} of ${maxIterations} (only 1 turn remaining). ` +
            `Do NOT invoke new exploratory tools or extra lint/test cycles. Complete the current step and summarize your work.`,
        });
      } else if (state.iteration === maxIterations && maxIterations > 1) {
        input.push({
          role: "user",
          content:
            `🛑 FINAL TURN REACHED (${maxIterations}/${maxIterations}): You must conclude now without calling additional tools. ` +
            `Provide your final response summary in Markdown explaining what was done, what files were created or modified, and how to verify.`,
        });
      }

      let result;
      let thinkingDurationMs = 0;
      try {
        const contextWindow = this.options.contextWindow
          ?? getModelCapabilities(this.options.model, this.options.capabilitiesOverride).contextWindow;
        let requestInput = input;
        if (shouldCompactHistory(input, contextWindow)) {
          // EX-3: PreCompact hooks fire best-effort before compaction.
          if (this.options.hooks?.PreCompact) {
            try {
              const { runHooks } = await import("./hooks.js");
              await runHooks(this.options.hooks, "PreCompact", { before: estimateHistoryChars(input) });
            } catch {
              // never block
            }
          }
          const before = estimateHistoryChars(input);
          // Scale the compact target to the window (aim to halve usage)
          // instead of the legacy fixed 28k-char budget, and bound the
          // kept recent outputs by tokens (10% of the window).
          const compactOpts = {
            maxTotalChars: Math.floor(contextWindow * 0.5 * 4),
            keepRecentToolOutputTokens: Math.floor(contextWindow * 0.1),
          };
          requestInput = this.options.summarizer
            ? await compactHistoryWithSummary(input, this.options.summarizer, compactOpts)
            : compactHistory(input, compactOpts);
          input = requestInput;
          this.emit({ type: "compaction", before, after: estimateHistoryChars(input) });
        }
        this.emit({ type: "turn_start", turn: state.iteration });
        const thinkingStart = Date.now();
        // Capability-aware tool exposure: hide git tools outside repos and
        // web_search without an endpoint so the model never hallucinates them.
        let toolExcludes: string[] = [];
        try {
          const { toolExcludesForRuntime } = await import("../llm/tools.js");
          toolExcludes = toolExcludesForRuntime({
            hygieneOn: this.flags.hygiene,
            economyOn: this.flags.economy,
            isGitRepo,
            sourceFileCount,
          });
        } catch {
          toolExcludes = [];
        }
        result = await this.callModel(requestInput, { signal, phase: state.phase, exclude: toolExcludes });
        thinkingDurationMs = Date.now() - thinkingStart;
        consecutiveApiErrors = 0;
        rateLimitRetries = 0;
        if (result?.output_text?.trim()) {
          lastModelOutputText = result.output_text.trim();
        }
        // Phase 4B: contract proposal rides on the first plan/read turn, never
        // its own turn. Confirm preserve against files already read.
        if (this.flags.apiLock && !runContract && state.iteration <= 2 && result?.output_text) {
          try {
            const { parseContractProposal, confirmContract } = await import("./contract.js");
            const proposal = parseContractProposal(result.output_text);
            if (proposal) {
              const { confirmed } = confirmContract(proposal, readContents);
              runContract = confirmed;
            }
          } catch {
            // contract is best-effort; empty means lock off
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (isAuthError(message)) {
          throw new Error(
            `LLM authentication failed: ${message}\n` +
              `Fix: check the key matches the endpoint — e.g. a gsk_ key needs the Groq endpoint ` +
              `(/endpoint https://api.groq.com/openai/v1) plus a Groq model (/model openai/gpt-oss-20b).`,
          );
        }
        // If the request exceeds the TPM/size limit, compact context aggressively and retry immediately
        const isRequestTooLarge = /413|request too large|limit \d+, requested \d+/i.test(message);
        if (isRequestTooLarge && input.length > 2) {
          if (this.reporter) {
            this.reporter.onProgressMessage("Request exceeded token/TPM limit. Compacting context...");
          } else {
            this.log(`Request exceeded token/TPM limit (${message}). Compacting context...`);
          }
          input = compactHistory(input, { aggressive: true, maxTotalChars: 8_000, keepRecentToolOutputs: 1 });
          continue;
        }

        // Rate limits: wait out the window and retry the request.
        // Never append to history here — that only grows the next request.
        if (isRateLimitError(message)) {
          if (rateLimitRetries >= MAX_RATE_LIMIT_RETRIES) {
            throw new Error(
              `LLM rate limit persisted after ${MAX_RATE_LIMIT_RETRIES} backoff retries: ${message}\n` +
                `Fix: switch to a roomier model (/model openai/gpt-oss-20b on Groq), or wait a minute and retry.`,
            );
          }
          const waitMs = RATE_LIMIT_BACKOFF_MS[rateLimitRetries] ?? 60_000;
          rateLimitRetries++;
          state.errors.push(`rate-limit (retry ${rateLimitRetries}, waiting ${waitMs / 1000}s)`);
          if (this.reporter) {
            this.reporter.onProgressMessage(`Rate limited. Waiting ${waitMs / 1000}s before retry ${rateLimitRetries}...`);
          } else {
            this.log(`Rate limited. Waiting ${waitMs / 1000}s before retry ${rateLimitRetries}... (Ctrl+C cancels)`);
          }
          await sleep(waitMs, signal);
          this.checkCancelled(signal);
          continue;
        }
        consecutiveApiErrors++;
        state.errors.push(message);
        if (this.reporter) {
          this.reporter.onError(`LLM API error (${consecutiveApiErrors}): ${message}`);
        } else {
          this.log(`LLM API error (${consecutiveApiErrors}): ${message}`);
        }
        if (consecutiveApiErrors >= MAX_CONSECUTIVE_API_ERRORS) {
          throw new Error(`LLM API failed ${consecutiveApiErrors} times in a row: ${message}`);
        }
        input.push({
          role: "user",
          content: `API ERROR (transient): ${message}. Continue with a different approach.`,
        });
        continue;
      }

      // Preserve conversation: feed model outputs back as input.
      for (const item of result.output) input.push(item);

      // Mid-thought output token limit recovery (Claude Code architecture pattern)
      if (result.finish_reason === "length") {
        if (maxOutputTokensRecoveryCount < 3) {
          maxOutputTokensRecoveryCount++;
          if (this.reporter) {
            this.reporter.onProgressMessage(
              `Output token limit reached. Prompting to resume mid-thought (${maxOutputTokensRecoveryCount}/3)...`,
            );
          } else {
            this.log(
              `Output token limit reached. Prompting to resume mid-thought (${maxOutputTokensRecoveryCount}/3)...`,
            );
          }
          input.push({
            role: "user",
            content:
              "Output token limit hit. Resume directly — no apology, no recap of what you were doing. " +
              "Pick up mid-thought if that is where the cut happened. Break remaining work into smaller pieces.",
          });
          continue;
        }
      } else {
        maxOutputTokensRecoveryCount = 0;
      }

      const toolCalls = result.output.filter((item) => item.type === "function_call");
      // Streaming providers already emitted incremental deltas via callModel.
      if (!this.providerInstance) {
        if (result.output_text) this.emit({ type: "text_delta", text: result.output_text });
        if (result.reasoning_text) this.emit({ type: "thinking_delta", text: result.reasoning_text });
      }
      if (result.usage) {
        this.usage.input += result.usage.input;
        this.usage.output += result.usage.output;
        // ML-9: accumulate prompt-cache hits so /cost can report them (live values only).
        this.usage.cachedInput += result.usage.cachedInput ?? 0;
        const cost = result.usage.costUsd ?? estimateCostUsd(this.options.model, result.usage.input, result.usage.output) ?? 0;
        this.usage.costUsd += cost;
        this.emit({
          type: "usage",
          input: result.usage.input,
          output: result.usage.output,
          cachedInput: result.usage.cachedInput,
          costUsd: cost,
          reasoningTokens: result.usage.reasoningTokens ?? null,
          usageEstimated: result.usage.usageEstimated ?? false,
          providerRetries: this.lastCallProviderRetries,
        });
        this.lastCallProviderRetries = 0;
        const used = this.usage.input + this.usage.output;
        if (this.options.maxTotalTokens && used > this.options.maxTotalTokens) {
          return {
            finalMessage: `Stopped: token budget of ${this.options.maxTotalTokens} exceeded (${used} tokens used).`,
            iterations: state.iteration,
            modifiedFiles: [...state.modifiedFiles],
            testResults: state.testResults,
            history: input,
            intent,
            stopReason: "budget",
            usage: { ...this.usage },
          };
        }
        if (this.options.maxCostUsd !== undefined && this.usage.costUsd > this.options.maxCostUsd) {
          return {
            finalMessage: `Stopped: cost budget of $${this.options.maxCostUsd} exceeded ($${this.usage.costUsd.toFixed(4)}).`,
            iterations: state.iteration,
            modifiedFiles: [...state.modifiedFiles],
            testResults: state.testResults,
            history: input,
            intent,
            stopReason: "budget",
            usage: { ...this.usage },
          };
        }
      }

      // Estimate tokens and notify reporter
      const totalChars = JSON.stringify(result.output).length + (result.reasoning_text?.length ?? 0);
      const estTokens = result.usage
        ? result.usage.input + result.usage.output
        : Math.max(12, Math.round(totalChars / 4));
      if (this.reporter?.setEstimatedTokens) {
        this.reporter.setEstimatedTokens(estTokens);
      }

      // Report thinking / reasoning text if present
      const thinkingParts: string[] = [];
      if (result.reasoning_text?.trim()) {
        thinkingParts.push(result.reasoning_text.trim());
      }
      if (
        toolCalls.length > 0 &&
        result.output_text?.trim() &&
        !thinkingParts.includes(result.output_text.trim())
      ) {
        thinkingParts.push(result.output_text.trim());
        if (this.reporter?.onInterStepMonologue) {
          this.reporter.onInterStepMonologue(result.output_text.trim());
        }
      }
      const thinkingText = thinkingParts.join("\n\n").trim();
      if (thinkingText) {
        if (this.reporter?.onThinking) {
          this.reporter.onThinking(thinkingText, thinkingDurationMs);
          if (i === 0 && rules.length > 0 && this.reporter.onThinkingRollup) {
            this.reporter.onThinkingRollup({
              durationMs: thinkingDurationMs,
              loadedRules: rules.map((r) => r.filePath),
            });
          }
        } else if (this.verbose) {
          this.log(`\n+ Thought: ${thinkingDurationMs}ms\n`);
        }
      } else if (i === 0 && rules.length > 0 && this.reporter?.onThinkingRollup) {
        this.reporter.onThinkingRollup({
          durationMs: thinkingDurationMs,
          loadedRules: rules.map((r) => r.filePath),
        });
      }

      // No tool calls -> model wants to finish. Enforce diff verification once.
      if (toolCalls.length === 0) {
        // No-action nudge: the model answered in text without calling any
        // tool and changed nothing (weak models stop after a text-only
        // first turn). Ask once for inspection before accepting — bounded
        // (one nudge, never on the last iteration), so genuine Q&A that
        // already used tools, changed files, or tracks todos is untouched,
        // and a repeated text-only answer still concludes.
        const acted =
          state.modifiedFiles.size > 0 ||
          this.todoManager.getTodos().length > 0 ||
          input.some(
            (item) =>
              typeof item === "object" &&
              item !== null &&
              (item as { type?: string }).type === "function_call",
          );
        if (!acted && noActionNudges < 1 && state.iteration < maxIterations) {
          noActionNudges++;
          input.push({
            role: "user",
            content:
              "You have not used any tools yet and no files have changed. " +
              "Do not summarize — inspect first: call read (or grep/glob/list_files) on the relevant files, " +
              "then complete the request with tools. If the request is a question, ground your answer in what you read.",
          });
          continue;
        }
        if (
          !result.output_text?.trim() &&
          !hasPromptedFinalSummary &&
          (state.modifiedFiles.size > 0 || this.todoManager.getTodos().length > 0)
        ) {
          hasPromptedFinalSummary = true;
          input.push({
            role: "user",
            content:
              "You have finished your tool execution. Please provide your final response summary in Markdown explaining what was done, what files were updated, and how to verify it.",
          });
          continue;
        }

        let finalText = result.output_text?.trim();
        if (!finalText) {
          const todos = this.todoManager.getTodos();
          const completed = todos.filter((t) => t.status === "completed");
          const lines: string[] = ["## Summary"];
          if (completed.length > 0) {
            lines.push("Successfully completed all implementation tasks:");
            for (const t of completed) {
              lines.push(`- **${t.content}**`);
            }
          } else {
            lines.push("- Task execution completed successfully.");
          }
          if (state.modifiedFiles.size > 0) {
            lines.push("\n## Files Changed");
            for (const f of state.modifiedFiles) {
              lines.push(`- \`${f}\``);
            }
          }
          if (state.testResults.length > 0) {
            lines.push("\n## Verification");
            for (const t of state.testResults) {
              lines.push(`- Ran \`${t.command}\` (exit code: ${t.exitCode})`);
            }
          }
          finalText = lines.join("\n");
        }

        if (state.modifiedFiles.size > 0 && !reviewed) {
          reviewed = true;
          state.phase = "review";
          const { isGitRepo } = await import("../tools/git.js");
          const inGit = await isGitRepo(repoRoot);
          if (inGit) {
            if (this.reporter) {
              this.reporter.onProgressMessage("Final diff verification pass...");
            } else {
              this.log("Final diff verification pass...");
            }
            try {
              const status = await executeTool(repoRoot, "git_status", {}, signal);
              const diff = await executeTool(repoRoot, "git_diff", {}, signal);
              input.push({
                role: "user",
                content:
                  `You modified files but have not shown a self-review yet.\n` +
                  `<git_status>\n${status}\n</git_status>\n` +
                  `<git_diff>\n${diff}\n</git_diff>\n\n` +
                  `Review the diff: is it minimal, correct, and verified by tests? ` +
                  `If fixes are needed, call tools. Otherwise reply with the final summary ` +
                  `in the required FINAL RESPONSE FORMAT.`,
              });
              continue;
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              state.errors.push(message);
              // Verification tooling failed — never present as verified.
              finalText += `\n\n[Verification skipped: diff review unavailable (${message.slice(0, 200)})]`;
            }
          }
        }

        // Stop Hooks & Quality Enforcement Loop (Claude Code handleStopHooks pattern)
        const stopHookResult = await evaluateStopHooks({
          repoRoot,
          modifiedFiles: state.modifiedFiles,
          todoManager: this.todoManager,
          planModeManager: this.planModeManager,
          stopOnGreen: this.flags.stopOnGreen,
          verificationGreen,
          tempTestFiles: [...tempTestFiles],
        });

        // EX-3: user Stop hooks fire best-effort before concluding.
        // A hook blocks only when its stdout says BLOCK (case-insensitive);
        // otherwise its output is advisory and conclusion proceeds.
        let userStopBlock: string | null = null;
        if (this.options.hooks?.Stop) {
          try {
            const { runHooks } = await import("./hooks.js");
            const outs = await runHooks(this.options.hooks, "Stop", {
              modifiedFiles: [...state.modifiedFiles],
              todos: this.todoManager.getTodos().length,
            });
            for (const o of outs) {
              if (/block/i.test(o.stdout)) {
                userStopBlock = o.stdout.slice(0, 2000);
                break;
              }
            }
          } catch {
            // never block on hook failure
          }
        }

        if (!stopHookResult.canConclude || userStopBlock) {
          stopHookRetries++;
          const builtIn = stopHookResult.canConclude ? [] : stopHookResult.blockingErrors;
          const allBlocks = userStopBlock ? [...builtIn, `[USER STOP HOOK BLOCKED]:\n${userStopBlock}`] : builtIn;
          if (stopHookRetries > MAX_STOP_HOOK_RETRIES) {
            const warning = `Stop hook retry budget reached (${MAX_STOP_HOOK_RETRIES} attempts). Concluding with unresolved issues: ${allBlocks.join(" | ")}`;
            state.errors.push(warning);
            if (this.reporter) {
              this.reporter.onProgressMessage(warning);
            } else {
              this.log(warning);
            }
            // Conclude instead of looping indefinitely
          } else {
            if (this.reporter) {
              this.reporter.onProgressMessage(
                `Stop hook blocked completion (${stopHookRetries}/${MAX_STOP_HOOK_RETRIES}, ${allBlocks.length} issue(s) remaining)...`,
              );
            } else {
              this.log(
                `Stop hook blocked completion (${stopHookRetries}/${MAX_STOP_HOOK_RETRIES}, ${allBlocks.length} issue(s) remaining)...`,
              );
            }
            input.push({
              role: "user",
              content: allBlocks.join("\n\n"),
            });
            continue;
          }
        }

        state.phase = "done";
        this.reporter?.stop();
        const done = {
          finalMessage: finalText,
          iterations: state.iteration,
          modifiedFiles: [...state.modifiedFiles],
          testResults: state.testResults,
          history: input,
          intent,
          stopReason: lastDenied ? ("permission" as const) : ("ok" as const),
          usage: { ...this.usage },
        };
        this.emit({ type: "done", result: done });
        return done;
      }

      const executeSingleCall = async (call: (typeof toolCalls)[number]) => {
        this.checkCancelled(signal);
        const callId = call.call_id ?? `call-${state.toolCalls.length}`;
        const name = String(call.name ?? "unknown");

        let args: Record<string, unknown>;
        try {
          args = call.arguments ? JSON.parse(call.arguments) : {};
          if (typeof args !== "object" || args === null || Array.isArray(args)) {
            throw new Error("arguments must be a JSON object");
          }
        } catch {
          // ML-4: small models get one JSON-repair attempt before failing.
          try {
            const repaired = repairToolArgumentsJson(String(call.arguments ?? ""));
            const parsed = JSON.parse(repaired) as Record<string, unknown>;
            if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
              args = parsed;
            } else {
              throw new Error("repair failed");
            }
          } catch {
            const output = `TOOL ERROR (${name}): malformed JSON arguments. Retry with a valid JSON object matching the tool schema.`;
            if (this.reporter) {
              this.reporter.onError(output);
            } else {
              this.log(output);
            }
            return { callId, name, args: {}, output, success: false, summary: "malformed args" };
          }
        }

        // Repeated-action detection (crude but effective).
        const sig = signatureFor(name, args);
        state.recentSignatures.push(sig);
        if (state.recentSignatures.length > RECENT_WINDOW) state.recentSignatures.shift();
        const repeats = state.recentSignatures.filter((s) => s === sig).length;
        // Phase 4A progressRedirect: same command twice with no write since
        // (or same failure text) -> block + evidence, ask for new hypothesis.
        // Fires at 2 (earlier than warn-at-3); abort-at-6 stays the backstop.
        // Inquiry exempt so Q&A can reread (conversational already returned).
        if (this.flags.progressRedirect && name === "run_command" && repeats >= 2 && intent !== "inquiry") {
          try {
            const { shouldRedirectProgress } = await import("./progress.js");
            const lastErr = state.errors.slice(-1)[0] ?? "";
            const verdict = shouldRedirectProgress({
              name,
              args,
              toolCalls: state.toolCalls,
              testResults: state.testResults,
              errors: state.errors,
              intent,
              lastOutput: lastErr,
            });
            if (verdict.redirect) {
              const remainingTurns = maxIterations - state.iteration;
              const remainingMs = Math.max(0, 600_000 - (Date.now() - runStartMs));
              const evidence =
                `${verdict.reason}\n[EVIDENCE last command: ${String(args.command ?? "").slice(0, 300)} | ` +
                `class: ${lastErr.slice(0, 160) || "(none)"} | remaining: ${remainingTurns} turns / ${Math.round(remainingMs / 1000)}s` +
                `${runContract?.preserve?.length ? ` | contract preserve: ${runContract.preserve.slice(0, 5).join(", ")}` : ""}]`;
              return { callId, name, args, output: `TOOL ERROR (${name}): ${evidence}`, success: false, summary: "progress redirect" };
            }
          } catch {
            // redirect is best-effort; fall through to warn/abort guards
          }
        }
        // Phase 4B apiLock: reject whole-file writes that drop preserved
        // package/exported signatures, and late overwrites after green build.
        if (this.flags.apiLock && runContract && runContract.preserve.length > 0 && (name === "write_file")) {
          try {
            const { shouldRejectWholeFileWrite, shouldRejectLateOverwrite } = await import("./contract.js");
            const p = typeof args.path === "string" ? args.path : "";
            const newContent = typeof args.content === "string" ? args.content : "";
            if (p && newContent) {
              const { default: fs } = await import("node:fs/promises");
              const { default: path } = await import("node:path");
              let oldContent: string | null = null;
              try {
                oldContent = await fs.readFile(path.join(repoRoot, p), "utf8");
              } catch {
                oldContent = null;
              }
              const rej = shouldRejectWholeFileWrite({
                filePath: p,
                oldContent,
                newContent,
                preserve: runContract.preserve,
                lastVerificationFailed,
                userText: userRequest,
              });
              if (rej.reject) {
                return { callId, name, args, output: `TOOL ERROR (${name}): ${rej.reason}`, success: false, summary: "api lock" };
              }
              const late = shouldRejectLateOverwrite({
                remainingTurns: maxIterations - state.iteration,
                remainingMs: Math.max(0, 600_000 - (Date.now() - runStartMs)),
                lastBuildGreen,
                isWholeFileWrite: true,
              });
              if (late.reject) {
                return { callId, name, args, output: `TOOL ERROR (${name}): ${late.reason}`, success: false, summary: "api lock late" };
              }
            }
          } catch (e) {
            if (e instanceof Error && /apiLock/.test(e.message)) throw e;
            // best-effort; fall through
          }
        }
        // Phase 4C contractTests: never invent network installs; guide missing tests.
        if (this.flags.contractTests && name === "run_command") {
          const cmd = String(args.command ?? "");
          if (/go\s+install\s|npm\s+(install|i)\s+-g|pip\s+install\s+(ruff|pyright|mypy)/i.test(cmd) && !/install/i.test(userRequest)) {
            return {
              callId,
              name,
              args,
              output: `TOOL ERROR (run_command): contractTests: network installs (${cmd.slice(0, 120)}) are rejected unless the user asked. Use the local toolchain.`,
              success: false,
              summary: "contractTests no-install",
            };
          }
        }
        if (repeats >= REPEAT_ABORT_THRESHOLD) {
          const tried = state.toolCalls
            .slice(-6)
            .map((call) => `${call.name} ${JSON.stringify(call.args).slice(0, 120)}`)
            .join("\n");
          throw new StuckError(
            [
              `Stuck: repeated '${name}' with identical arguments ${repeats} times. Stopping so this run can be resumed with a different approach.`,
              `Last arguments: ${JSON.stringify(args).slice(0, 400)}`,
              `Files modified so far: ${[...state.modifiedFiles].join(", ") || "(none)"}`,
              `Recent calls:\n${tried || "(none)"}`,
              `Recent errors: ${state.errors.slice(-3).join(" | ") || "(none)"}`,
            ].join("\n"),
          );
        }
        if (repeats >= REPEAT_WARN_THRESHOLD) {
          const warn =
            `TOOL ERROR (${name}): you have repeated this exact call ${repeats} times. ` +
            `Stop reading or searching. You already have sufficient context: proceed directly to creating or modifying files with write_file / edit_file, or answer the user.`;
          if (this.reporter) {
            this.reporter.onError(warn);
          } else {
            this.log(warn);
          }
          return { callId, name, args, output: warn, success: false, summary: "repeat warning" };
        }

        const pathArgEarly = typeof args.path === "string" ? args.path : "";
        if ((name === "read" || name === "read_file" || name === "view_file") && pathArgEarly && !this.permissions.checkRead(pathArgEarly)) {
          lastDenied = true;
          logAudit(repoRoot, { kind: "permission", tool: name, args: { path: pathArgEarly }, decision: "deny", detail: "read denied" });
          const output = `TOOL ERROR (${name}): User denied read of "${pathArgEarly}".`;
          return { callId, name, args, output, success: false, summary: "user denied read" };
        }
        if ((name === "write_file" || name === "edit_file" || name === "multi_edit") && pathArgEarly) {
          const allowedEdit = await this.permissions.checkEdit(pathArgEarly, name);
          if (!allowedEdit) {
            lastDenied = true;
            logAudit(repoRoot, { kind: "permission", tool: name, args: { path: pathArgEarly }, decision: "deny", detail: "edit denied" });
            const output = `TOOL ERROR (${name}): User denied edit of "${pathArgEarly}". Propose a different approach or ask for permission.`;
            if (this.reporter) this.reporter.onToolComplete(name, args, "User denied edit", false, 0);
            return { callId, name, args, output, success: false, summary: "user denied edit" };
          }
        }
        if (name === "run_command") {
          const cmd = String(args.command ?? "");
          const allowed = await this.permissions.checkCommand(cmd);
          if (!allowed) {
            lastDenied = true;
            logAudit(repoRoot, { kind: "permission", tool: name, args: { command: cmd }, decision: "deny", detail: "command denied" });
            const output = `TOOL ERROR (run_command): User denied execution of command "${cmd}". Propose a different approach or proceed without running this command.`;
            if (this.reporter) {
              this.reporter.onToolComplete(name, args, "User denied execution", false, 0);
            } else {
              this.log(output);
            }
            return { callId, name, args, output, success: false, summary: "user denied command" };
          }
        }
        // EX-1: MCP tools (mcp__server__tool) get per-tool permission checks.
        // Fail closed when no checker is present (Claude Code parity).
        if (name.startsWith("mcp__")) {
          const { parseNamespacedTool } = await import("../mcp/client.js");
          const parsed = parseNamespacedTool(name);
          const server = parsed?.server ?? "unknown";
          const tool = parsed?.tool ?? name;
          const checker = (this.permissions as unknown as { checkMcp?: (s: string, t: string) => Promise<boolean> }).checkMcp;
          const allowedMcp = checker ? await checker.call(this.permissions, server, tool) : false;
          if (!allowedMcp) {
            lastDenied = true;
            logAudit(repoRoot, { kind: "permission", tool: name, args, decision: "deny", detail: "mcp denied" });
            const output = `TOOL ERROR (${name}): User denied MCP tool "${tool}" on server "${server}".`;
            return { callId, name, args, output, success: false, summary: "user denied mcp" };
          }
        }

        const toolStartTime = Date.now();
        if (this.reporter) {
          const activeTask = this.todoManager.getActiveTask();
          this.reporter.onToolStart(name, args, activeTask?.activeForm || activeTask?.content);
        } else {
          this.log(`\n> ${name}`, JSON.stringify(args).slice(0, 500));
        }

        const pathArg = typeof args.path === "string" ? args.path : null;
        const hadReadBefore = pathArg ? state.relevantFiles.has(pathArg) : true;

        let toolOutput: string;
        let success = true;
        try {
          this.emit({ type: "tool_start", id: callId, name, args });
          toolOutput = await executeTool(repoRoot, name, args, signal, {
            todoManager: this.todoManager,
            planModeManager: this.planModeManager,
            fileStateCache: this.fileStateCache,
            responder: this.responder,
            providerOverrides: this.providerOverrides,
            planApprover: this.options.planApprover,
            askUser: this.options.askUser,
            hooks: this.options.hooks,
            commandRunner: this.options.commandRunner,
            sandboxMode: this.options.sandboxMode,
            flags: this.flags,
            isGitRepo,
            sourceFileCount,
            // AG-14: stream spawn chunks as tool_output_delta events.
            onToolOutputDelta: (chunk: string) => this.emit({ type: "tool_output_delta", id: callId, chunk }),
          });
          // Phase 4C contractTests: missing-test guidance (same package, no invented assertions).
          if (this.flags.contractTests && /\[no test files\]|no test files/i.test(toolOutput)) {
            toolOutput +=
              `\n[contractTests: go test reports no test files. Write a temp test in the SAME package ` +
              `(e.g. _contract_tmp_test.go with the file's package clause), run it, and delete it before stop. ` +
              `Do not invent assertions — check the preserved API only.]`;
            try {
              const m = /_contract_tmp_test\.go|_eval_tmp_test\.go/.test(toolOutput) ? null : null;
              void m;
            } catch {
              // ignore
            }
          }
          // EX-3 PostToolUse hooks (best effort, never block).
          if (this.options.hooks) {
            try {
              const { runHooks } = await import("./hooks.js");
              await runHooks(this.options.hooks, "PostToolUse", { tool: name, output: toolOutput.slice(0, 2000) });
            } catch {
              // ignore
            }
          }
        } catch (error) {
          success = false;
          let message = error instanceof Error ? error.message : String(error);
          if (name === "edit_file" && pathArg && !hadReadBefore) {
            message += ` (Safety advisory: file '${pathArg}' was not inspected before editing; call read first to verify exact contents)`;
          }
          toolOutput = `TOOL ERROR (${name}): ${message}`;
          state.errors.push(`${name}: ${message}`);
        }

        if (name === "todo_write" && success) {
          if (this.reporter?.onTodoUpdate) {
            this.reporter.onTodoUpdate(this.todoManager.getTodos());
          }
        }
        if (name === "enter_plan_mode" && success) {
          if (this.reporter?.onPlanModeChange) {
            this.reporter.onPlanModeChange(true);
          }
        }
        if (name === "exit_plan_mode" && success) {
          if (this.reporter?.onPlanModeChange) {
            const planText = String(args.plan_summary ?? args.plan ?? "");
            this.reporter.onPlanModeChange(false, planText);
          }
        }

        const toolDuration = Date.now() - toolStartTime;
        if (success) lastDenied = false;
        this.emit({ type: "tool_end", id: callId, ok: success, output: toolOutput.slice(0, 500), ms: toolDuration });
        logAudit(repoRoot, {
          kind: "tool",
          tool: name,
          args,
          ok: success,
          ms: toolDuration,
          detail: toolOutput.slice(0, 300),
        });
        // Always cap before reporter/history/audit — the TUI path previously
        // pushed unbounded output into context (2M maxBuffer blowup).
        toolOutput = truncate(toolOutput, MAX_TOOL_OUTPUT_CHARS);
        if (this.reporter) {
          this.reporter.onToolComplete(name, args, toolOutput, success, toolDuration);
        } else {
          if (success) this.log(toolOutput.slice(0, 1000));
          else this.log(toolOutput);
        }

        // Bookkeeping the model can't be trusted to do itself.
        if (pathArg && ["read", "read_file", "view_file", "write_file", "edit_file", "view_symbol_outline"].includes(name)) {
          state.relevantFiles.add(pathArg);
        }
        // Thin-runtime: remember read contents for contract confirmation.
        if (pathArg && success && (name === "read" || name === "read_file" || name === "view_file")) {
          readContents.set(pathArg, toolOutput.slice(0, 20_000));
        }
        // Phase 4C: track temp contract-test files for deletion before stop.
        if (this.flags.contractTests && success && name === "write_file" && pathArg) {
          if (/_contract_tmp_test\.go$|_eval_tmp_test\.go$|_contract_tmp_test\.py$|_eval_tmp\.py$/.test(pathArg)) {
            tempTestFiles.add(pathArg);
          }
        }
        if (pathArg && success && ["write_file", "edit_file"].includes(name)) {
          state.modifiedFiles.add(pathArg);
          try {
            const diags = await getQuickDiagnostics(repoRoot, pathArg);
            if (diags) {
              toolOutput += `\n\n[IN-LOOP COMPILER DIAGNOSTIC for ${pathArg}]\n${diags}\nNote: Fix these compiler issues immediately in your next edit.`;
            }
          } catch {
            // Ignore diagnostic error — best effort
          }
        }
        if (name === "run_command" && success) {
          const exitCode = extractExitCode(toolOutput) ?? -1;
          state.testResults.push({
            command: String(args.command ?? ""),
            exitCode,
            outputPreview: toolOutput.slice(-2000),
          });
          // Thin-runtime verification signals (Phase 1 scorecard labels only).
          const nonEmpty = toolOutput.replace(/exit code:\s*-?\d+/i, "").trim().length > 0;
          if (exitCode === 0 && nonEmpty) {
            const { isEmptyScriptSuccess } = await import("../tools/semantics.js").catch(() => ({ isEmptyScriptSuccess: null }));
            const empty = typeof isEmptyScriptSuccess === "function"
              ? (isEmptyScriptSuccess as (c: string, e: number, o: string, s: string) => boolean)(
                String(args.command ?? ""),
                exitCode,
                toolOutput,
                "",
              )
              : false;
            if (!(this.flags.hygiene && empty)) {
              verificationGreen = true;
              lastBuildGreen = /go build|go test|tsc|npm test|pytest|ruff/i.test(String(args.command ?? "")) ? true : lastBuildGreen;
            } else {
              lastVerificationFailed = true;
            }
          } else if (exitCode !== 0) {
            lastVerificationFailed = true;
          }
        }

        return {
          callId,
          name,
          args,
          output: toolOutput,
          success,
          summary: toolOutput.slice(0, 200),
        };
      };

      // F-17: single batching implementation via StreamingToolExecutor.
      // ML-4: small-model mode enforces one tool per turn (first call only).
      let effectiveCalls = toolCalls;
      try {
        const smallMode = this.smallModelForced ?? isSmallModelMode(this.options.model, loadModelSettings(repoRoot));
        if (smallMode && toolCalls.length > 1) {
          effectiveCalls = [toolCalls[0]!];
          if (this.verbose) this.log(`Small-model mode: executing 1 of ${toolCalls.length} tool calls this turn.`);
        }
      } catch {
        // small-model check is best-effort
      }
      // ML-4: filter to the small-model tool subset for the prompt contract;
      // unknown tools still error recoverably at dispatch.
      void filterToolsForSmallModel;
      const executor = new StreamingToolExecutor(signal);
      const batches = executor.partitionBatches(
        effectiveCalls.map((c, idx) => ({ id: String(c.call_id ?? `call-${idx}`), name: String(c.name ?? "unknown"), args: {} })),
      );
      // Map partitions back to the original call objects by index order.
      const callById = new Map(effectiveCalls.map((c, idx) => [String(c.call_id ?? `call-${idx}`), c]));
      const orderedBatches: (typeof effectiveCalls)[] = batches.map((b) =>
        b.map((item) => callById.get(item.id)!).filter(Boolean),
      );

      for (const batch of orderedBatches) {
        const isParallel = batch.length > 1 && isConcurrencySafeTool(String(batch[0].name ?? ""));
        if (isParallel && this.reporter) {
          this.reporter.onProgressMessage(
            `Running ${batch.length} read operations concurrently: ${batch.map((b) => b.name).join(", ")}...`,
          );
        }
        let executed: Awaited<ReturnType<typeof executeSingleCall>>[];
        try {
          executed = isParallel
            ? await Promise.all(batch.map((call) => executeSingleCall(call)))
            : [await executeSingleCall(batch[0]!)];
        } catch (error) {
          if (error instanceof StuckError) {
            const stuck = {
              finalMessage: error.message,
              iterations: state.iteration,
              modifiedFiles: [...state.modifiedFiles],
              testResults: state.testResults,
              history: input,
              intent,
              stopReason: "stuck" as const,
              usage: { ...this.usage },
            };
            this.emit({ type: "done", result: stuck });
            return stuck;
          }
          throw error;
        }

        for (const res of executed) {
          state.toolCalls.push({
            iteration: state.iteration,
            name: res.name,
            args: res.args,
            success: res.success,
            summary: res.summary,
          });
          input.push({ type: "function_call_output", call_id: res.callId, output: res.output });
        }

        // No-progress detector: stall without exact repeats (e.g. every
        // call fails differently, or reads pile up with no durable effect).
        const verdict = detectNoProgress({
          toolCalls: state.toolCalls,
          testResults: state.testResults,
          errors: state.errors,
          modifiedFilesCount: state.modifiedFiles.size,
          hygieneOn: this.flags.hygiene,
        });
        if (verdict.stalled) {
          const stuck = {
            finalMessage: [
              `Stuck: ${verdict.reason ?? "no forward progress detected."} Stopping so this run can be resumed with a different approach.`,
              `Files modified so far: ${[...state.modifiedFiles].join(", ") || "(none)"}`,
              `Recent errors: ${state.errors.slice(-3).join(" | ") || "(none)"}`,
            ].join("\n"),
            iterations: state.iteration,
            modifiedFiles: [...state.modifiedFiles],
            testResults: state.testResults,
            history: input,
            intent,
            stopReason: "stuck" as const,
            usage: { ...this.usage },
          };
          this.emit({ type: "done", result: stuck });
          return stuck;
        }
      }
      // Phase 4D stopOnGreen nudge: once the last targeted check is green
      // with real output, tell the model to conclude instead of wandering.
      // Turns-to-green ignores post-green wandering, so this nudge is judged
      // on total turns of passing tasks.
      if (this.flags.stopOnGreen && verificationGreen && !greenNudgeSent && state.iteration < maxIterations) {
        greenNudgeSent = true;
        input.push({
          role: "user",
          content:
            `Last targeted check is green with real output and no open errors. ` +
            `Conclude now with the final summary — do not run extra reads, tests, or lint cycles because turns remain.`,
        });
      }
    }

    // Budget exhausted: rather than crashing with an unhandled exception,
    // synthesize a structured summary and conclude with stopReason: "budget".
    const budgetSummaryLines: string[] = [
      `### ⚠️ Iteration Limit Reached (${maxIterations}/${maxIterations} turns)`,
      "",
      "CodeAgent reached the maximum iteration budget for this task before concluding all actions.",
    ];

    if (lastModelOutputText) {
      budgetSummaryLines.push("\n#### Latest Agent Note:\n" + lastModelOutputText);
    }

    if (state.modifiedFiles.size > 0) {
      budgetSummaryLines.push("\n#### Files Created / Modified:");
      for (const f of state.modifiedFiles) {
        budgetSummaryLines.push(`- \`${f}\``);
      }
    }

    if (state.testResults.length > 0) {
      budgetSummaryLines.push("\n#### Verification / Test Runs:");
      for (const t of state.testResults) {
        const icon = t.exitCode === 0 ? "✅" : "❌";
        budgetSummaryLines.push(`- ${icon} Ran \`${t.command}\` (exit code: ${t.exitCode})`);
      }
    }

    if (state.errors.length > 0) {
      budgetSummaryLines.push("\n#### Diagnostic / Error Log:");
      for (const err of state.errors.slice(-3)) {
        budgetSummaryLines.push(`- ${err}`);
      }
    }

    budgetSummaryLines.push(
      "\n---\n*You can ask CodeAgent to continue from here, or review the changes in your editor.*",
    );

    const budgetResult: AgentRunResult = {
      finalMessage: budgetSummaryLines.join("\n"),
      iterations: maxIterations,
      modifiedFiles: [...state.modifiedFiles],
      testResults: state.testResults,
      history: input,
      intent,
      stopReason: "budget" as const,
      usage: { ...this.usage },
    };
    this.emit({ type: "done", result: budgetResult });
    return budgetResult;
    } finally {
      this.reporter?.stop();
    }
  }
}

