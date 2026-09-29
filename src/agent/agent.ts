import { executeTool } from "../tools/index.js";
import { buildInitialContext } from "./context.js";
import { discoverRules } from "./rules.js";
import {
  createInitialState,
  inferPhase,
  type AgentConfig,
  type AgentRunResult,
  type AgentState,
} from "./types.js";
import { classifyIntent } from "./intent.js";
import type { Responder } from "../llm/client.js";
import { createProviderFromEnv } from "../llm/provider.js";
import { truncate } from "../utils/truncate.js";

import { PermissionManager } from "./permissions.js";
import { compactHistory } from "./compactor.js";
import { getQuickDiagnostics } from "./diagnostics.js";
import type { AgentReporter } from "../cli/ui/reporter.js";
import { TodoManager } from "./todo.js";
import { PlanModeManager } from "./planMode.js";
import { evaluateStopHooks } from "./stopHooks.js";
import { FileStateCache } from "../tools/fileStateCache.js";
import { isConcurrencySafeTool } from "../tools/streamingExecutor.js";

export interface AgentOptions extends AgentConfig {
  /** Injected for tests — defaults to the provider selected from env. */
  responder?: Responder;
  /** Optional verbose logging (default true). */
  verbose?: boolean;
  /** Injectable clock for tests (default: real setTimeout). */
  sleep?: (ms: number) => Promise<void>;
  /** Permission manager for commands and destructive actions. */
  permissions?: PermissionManager;
  /** Optional visual progress reporter (spinners, tool cards). */
  reporter?: AgentReporter;
  /** Dynamic task/todo manager. */
  todoManager?: TodoManager;
  /** Plan mode state manager. */
  planModeManager?: PlanModeManager;
  /** File snapshot & drift cache. */
  fileStateCache?: FileStateCache;
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
  return /429|413|rate.?limit|too many requests|tokens per minute|\bTPM\b|\bRPD\b|overloaded|capacity/i.test(
    message,
  );
}

/** 401/403s never resolve by retrying — fail immediately with a fix. */
export function isAuthError(message: string): boolean {
  return /401|403|invalid api key|incorrect api key|unauthorized|authentication/i.test(message);
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
  private verbose: boolean;
  private permissions: PermissionManager;
  private reporter?: AgentReporter;
  private todoManager: TodoManager;
  private planModeManager: PlanModeManager;
  private fileStateCache: FileStateCache;

  constructor(private options: AgentOptions) {
    this.verbose = options.verbose ?? true;
    this.responder =
      options.responder ??
      createProviderFromEnv(process.env, { model: options.model }).responder;
    this.permissions = options.permissions ?? new PermissionManager({ autoApprove: true });
    this.reporter = options.reporter;
    this.todoManager = options.todoManager ?? new TodoManager();
    this.planModeManager = options.planModeManager ?? new PlanModeManager();
    this.fileStateCache = options.fileStateCache ?? new FileStateCache();
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
    const intent = classifyIntent(userRequest);

    try {
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
        const result = await this.responder(input, { tools: false });
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

    // Ensure repository context is injected on the first non-conversational turn even after greetings
    const hasRepoContext = input.some((item) => {
      if (typeof item !== "object" || item === null) return false;
      const content = (item as { content?: unknown }).content;
      return typeof content === "string" && content.includes("<repository>");
    });

    const rules = discoverRules(repoRoot);

    if (!hasRepoContext) {
      const repoContext = await buildInitialContext(repoRoot, rules);
      input.push({
        role: "system",
        content: repoContext,
      });
    }
    input.push({
      role: "user",
      content: userRequest,
    });



    let consecutiveApiErrors = 0;
    let rateLimitRetries = 0;
    let maxOutputTokensRecoveryCount = 0;
    let reviewed = false;
    let hasPromptedFinalSummary = false;
    const sleep = this.options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

    for (let i = 0; i < maxIterations; i++) {
      this.checkCancelled(signal);
      state.iteration = i + 1;
      state.phase = inferPhase(state);
      if (this.reporter) {
        this.reporter.onIterationStart(state.iteration, maxIterations, state.phase);
      } else {
        this.log(`\n--- iteration ${state.iteration}/${maxIterations} [${state.phase}] ---`);
      }

      let result;
      let thinkingDurationMs = 0;
      try {
        const compacted = compactHistory(input);
        const thinkingStart = Date.now();
        result = await this.responder(compacted);
        thinkingDurationMs = Date.now() - thinkingStart;
        consecutiveApiErrors = 0;
        rateLimitRetries = 0;
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
          await sleep(waitMs);
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

      // Estimate tokens and notify reporter
      const totalChars = JSON.stringify(result.output).length + (result.reasoning_text?.length ?? 0);
      const estTokens = Math.max(12, Math.round(totalChars / 4));
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
            // Fall through and return — verification tooling itself failed.
          }
        }

        // Stop Hooks & Quality Enforcement Loop (Claude Code handleStopHooks pattern)
        const stopHookResult = await evaluateStopHooks({
          repoRoot,
          modifiedFiles: state.modifiedFiles,
          todoManager: this.todoManager,
          planModeManager: this.planModeManager,
        });

        if (!stopHookResult.canConclude) {
          if (this.reporter) {
            this.reporter.onProgressMessage(
              `Stop hook blocked completion (${stopHookResult.blockingErrors.length} issue(s) remaining)...`,
            );
          } else {
            this.log(
              `Stop hook blocked completion (${stopHookResult.blockingErrors.length} issue(s) remaining)...`,
            );
          }
          input.push({
            role: "user",
            content: stopHookResult.blockingErrors.join("\n\n"),
          });
          continue;
        }

        state.phase = "done";
        this.reporter?.stop();
        return {
          finalMessage: finalText,
          iterations: state.iteration,
          modifiedFiles: [...state.modifiedFiles],
          testResults: state.testResults,
          history: input,
          intent,
        };
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
          const output = `TOOL ERROR (${name}): malformed JSON arguments. Retry with a valid JSON object matching the tool schema.`;
          if (this.reporter) {
            this.reporter.onError(output);
          } else {
            this.log(output);
          }
          return { callId, name, args: {}, output, success: false, summary: "malformed args" };
        }

        // Repeated-action detection (crude but effective).
        const sig = signatureFor(name, args);
        state.recentSignatures.push(sig);
        if (state.recentSignatures.length > RECENT_WINDOW) state.recentSignatures.shift();
        const repeats = state.recentSignatures.filter((s) => s === sig).length;
        if (repeats >= REPEAT_ABORT_THRESHOLD) {
          throw new Error(
            `Agent appears stuck repeating '${name}' with identical arguments (${repeats}x). Aborting.`,
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

        if (name === "run_command") {
          const cmd = String(args.command ?? "");
          const allowed = await this.permissions.checkCommand(cmd);
          if (!allowed) {
            const output = `TOOL ERROR (run_command): User denied execution of command "${cmd}". Propose a different approach or proceed without running this command.`;
            if (this.reporter) {
              this.reporter.onToolComplete(name, args, "User denied execution", false, 0);
            } else {
              this.log(output);
            }
            return { callId, name, args, output, success: false, summary: "user denied command" };
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
          toolOutput = await executeTool(repoRoot, name, args, signal, {
            todoManager: this.todoManager,
            planModeManager: this.planModeManager,
            fileStateCache: this.fileStateCache,
          });
        } catch (error) {
          success = false;
          let message = error instanceof Error ? error.message : String(error);
          if (name === "edit_file" && pathArg && !hadReadBefore) {
            message += ` (Safety advisory: file '${pathArg}' was not inspected before editing; call read_file or view_file first to verify exact contents)`;
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
        if (this.reporter) {
          this.reporter.onToolComplete(name, args, toolOutput, success, toolDuration);
        } else {
          toolOutput = truncate(toolOutput, MAX_TOOL_OUTPUT_CHARS);
          if (success) this.log(toolOutput.slice(0, 1000));
          else this.log(toolOutput);
        }

        // Bookkeeping the model can't be trusted to do itself.
        if (pathArg && ["read_file", "view_file", "write_file", "edit_file", "view_symbol_outline"].includes(name)) {
          state.relevantFiles.add(pathArg);
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
          state.testResults.push({
            command: String(args.command ?? ""),
            exitCode: extractExitCode(toolOutput) ?? -1,
            outputPreview: toolOutput.slice(-2000),
          });
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

      // Partition tool calls into consecutive batches
      const batches: (typeof toolCalls)[] = [];
      let currentBatch: typeof toolCalls = [];
      let currentBatchIsReadOnly = false;

      for (const call of toolCalls) {
        const isReadOnly = isConcurrencySafeTool(String(call.name ?? ""));
        if (currentBatch.length === 0) {
          currentBatch.push(call);
          currentBatchIsReadOnly = isReadOnly;
        } else if (isReadOnly && currentBatchIsReadOnly) {
          currentBatch.push(call);
        } else {
          batches.push(currentBatch);
          currentBatch = [call];
          currentBatchIsReadOnly = isReadOnly;
        }
      }
      if (currentBatch.length > 0) {
        batches.push(currentBatch);
      }

      for (const batch of batches) {
        const isParallel = batch.length > 1 && isConcurrencySafeTool(String(batch[0].name ?? ""));
        if (isParallel && this.reporter) {
          this.reporter.onProgressMessage(
            `Running ${batch.length} read operations concurrently: ${batch.map((b) => b.name).join(", ")}...`,
          );
        }
        const executed = isParallel
          ? await Promise.all(batch.map((call) => executeSingleCall(call)))
          : [await executeSingleCall(batch[0])];

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
      }
    }

    throw new Error(`Agent exceeded max iterations (${maxIterations}) without finishing.`);
    } finally {
      this.reporter?.stop();
    }
  }
}

