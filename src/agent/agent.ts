import { executeTool } from "../tools/index.js";
import { buildInitialContext } from "./context.js";
import {
  createInitialState,
  inferPhase,
  type AgentConfig,
  type AgentRunResult,
  type AgentState,
} from "./types.js";
import type { Responder } from "../llm/client.js";
import { createProviderFromEnv } from "../llm/provider.js";
import { truncate } from "../utils/truncate.js";

export interface AgentOptions extends AgentConfig {
  /** Injected for tests — defaults to the provider selected from env. */
  responder?: Responder;
  /** Optional verbose logging (default true). */
  verbose?: boolean;
  /** Injectable clock for tests (default: real setTimeout). */
  sleep?: (ms: number) => Promise<void>;
}

export interface RunOpts {
  signal?: AbortSignal;
}

const MAX_CONSECUTIVE_API_ERRORS = 3;
const RECENT_WINDOW = 8;
const REPEAT_WARN_THRESHOLD = 3;
const REPEAT_ABORT_THRESHOLD = 6;
const MAX_TOOL_OUTPUT_CHARS = 40_000;
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

  constructor(private options: AgentOptions) {
    this.verbose = options.verbose ?? true;
    this.responder =
      options.responder ??
      createProviderFromEnv(process.env, { model: options.model }).responder;
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

    const repoContext = await buildInitialContext(repoRoot);
    const input: unknown[] = [
      {
        role: "user",
        content: `${repoContext}\n\n<task>\n${userRequest}\n</task>`,
      },
    ];

    let consecutiveApiErrors = 0;
    let rateLimitRetries = 0;
    let reviewed = false;
    const sleep = this.options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

    for (let i = 0; i < maxIterations; i++) {
      this.checkCancelled(signal);
      state.iteration = i + 1;
      state.phase = inferPhase(state);
      this.log(`\n--- iteration ${state.iteration}/${maxIterations} [${state.phase}] ---`);

      let result;
      try {
        result = await this.responder(input);
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
        // Rate limits: wait out the window and retry the IDENTICAL request.
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
          this.log(`Rate limited. Waiting ${waitMs / 1000}s before retry ${rateLimitRetries}... (Ctrl+C cancels)`);
          await sleep(waitMs);
          this.checkCancelled(signal);
          continue;
        }
        consecutiveApiErrors++;
        state.errors.push(message);
        this.log(`LLM API error (${consecutiveApiErrors}): ${message}`);
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

      const toolCalls = result.output.filter((item) => item.type === "function_call");

      // No tool calls -> model wants to finish. Enforce diff verification once.
      if (toolCalls.length === 0) {
        const finalText = result.output_text?.trim() || "(empty final response)";
        if (state.modifiedFiles.size > 0 && !reviewed) {
          reviewed = true;
          state.phase = "review";
          this.log("Final diff verification pass...");
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
        state.phase = "done";
        return {
          finalMessage: finalText,
          iterations: state.iteration,
          modifiedFiles: [...state.modifiedFiles],
          testResults: state.testResults,
        };
      }

      // Execute tool calls sequentially, in model-provided order.
      for (const call of toolCalls) {
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
          this.log(output);
          input.push({ type: "function_call_output", call_id: callId, output });
          state.toolCalls.push({
            iteration: state.iteration,
            name,
            args: {},
            success: false,
            summary: "malformed args",
          });
          continue;
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
            `Stop and try a different approach (read different files, refine the fix, or inspect the diff).`;
          this.log(warn);
          input.push({ type: "function_call_output", call_id: callId, output: warn });
          continue;
        }

        this.log(`\n> ${name}`, JSON.stringify(args).slice(0, 500));
        let toolOutput: string;
        let success = true;
        try {
          toolOutput = await executeTool(repoRoot, name, args, signal);
        } catch (error) {
          success = false;
          const message = error instanceof Error ? error.message : String(error);
          toolOutput = `TOOL ERROR (${name}): ${message}`;
          state.errors.push(`${name}: ${message}`);
          this.log(toolOutput);
        }

        toolOutput = truncate(toolOutput, MAX_TOOL_OUTPUT_CHARS);
        if (success) this.log(toolOutput.slice(0, 1000));

        // Bookkeeping the model can't be trusted to do itself.
        const pathArg = typeof args.path === "string" ? args.path : null;
        if (pathArg && ["read_file", "write_file", "edit_file"].includes(name)) {
          state.relevantFiles.add(pathArg);
        }
        if (pathArg && success && ["write_file", "edit_file"].includes(name)) {
          state.modifiedFiles.add(pathArg);
        }
        if (name === "run_command" && success) {
          state.testResults.push({
            command: String(args.command ?? ""),
            exitCode: extractExitCode(toolOutput) ?? -1,
            outputPreview: toolOutput.slice(-2000),
          });
        }

        state.toolCalls.push({
          iteration: state.iteration,
          name,
          args,
          success,
          summary: toolOutput.slice(0, 200),
        });

        input.push({ type: "function_call_output", call_id: callId, output: toolOutput });
      }
    }

    throw new Error(`Agent exceeded max iterations (${maxIterations}) without finishing.`);
  }
}
