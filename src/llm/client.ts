import OpenAI from "openai";
import { mapResponsesApiResult } from "./responsesMap.js";
import { withProviderRetry } from "./retry.js";

/**
 * Thin wrapper: env validation + client construction.
 * The agent loop lives in agent/agent.ts and takes an injected
 * responder so tests can run without network access.
 */
export function getApiKey(): string {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    throw new Error(
      "OPENAI_API_KEY is not set. Copy .env.example to .env and add your key.",
    );
  }
  return key;
}

export function createOpenAIClient(apiKey?: string): OpenAI {
  return new OpenAI({ apiKey: apiKey ?? getApiKey() });
}

/** Minimal shape of what the agent needs from client.responses.create. */
export interface ResponsesCreateResult {
  output: Array<{
    type: string;
    call_id?: string;
    name?: string;
    arguments?: string;
    /** Assistant text, or the original content payload for reasoning items. */
    content?: unknown;
    role?: string;
    id?: string;
    summary?: unknown;
    encrypted_content?: string;
    status?: string;
  }>;
  output_text: string;
  /** Extracted thinking / reasoning text from models that support it. */
  reasoning_text?: string;
  /** Provider finish reason (e.g., 'stop', 'length', 'tool_calls'). */
  finish_reason?: string;
  usage?: {
    input: number;
    output: number;
    cachedInput?: number;
    costUsd?: number;
    /** Null when the provider omits reasoning tokens (not zero). */
    reasoningTokens?: number | null;
    /** True when usage was estimated from text size. Never store silent 0. */
    usageEstimated?: boolean;
  };
}

export interface ResponderOptions {
  tools?: boolean;
  signal?: AbortSignal;
  /** Tool names to hide from the model (capability-aware exposure). */
  exclude?: string[];
}

export type Responder = (input: unknown[], options?: ResponderOptions) => Promise<ResponsesCreateResult>;

export function createResponder(
  client: OpenAI,
  args: { model: string; instructions: string },
): Responder {
  return async (input: unknown[], options?: ResponderOptions) => {
    const { tools } = await import("./tools.js");
    const useTools = options?.tools ?? true;
    const exclude = options?.exclude ?? [];
    const filtered = exclude.length > 0 ? tools.filter((t) => !exclude.includes(t.name)) : tools;
    const response = await withProviderRetry(
      () =>
        client.responses.create({
          model: args.model,
          instructions: args.instructions,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          tools: useTools ? (filtered as any) : undefined,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          input: input as any,
        }),
      { signal: options?.signal, maxAttempts: 3 },
    );
    return mapResponsesApiResult({
      output: response.output as unknown as Array<Record<string, unknown>>,
      output_text: response.output_text,
      status: (response as { status?: string }).status,
      incomplete_details: (response as { incomplete_details?: { reason?: string } | null }).incomplete_details,
      usage: (response as { usage?: {
        input_tokens?: number;
        output_tokens?: number;
        input_tokens_details?: { cached_tokens?: number };
      } }).usage,
    });
  };
}
