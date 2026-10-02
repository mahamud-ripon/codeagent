import type { ResponsesCreateResult } from "./client.js";
import type { ModelCapabilities } from "./capabilities.js";
import { CONSERVATIVE_CAPABILITIES } from "./capabilities.js";
import type { ProviderEvent, StreamRequest } from "./events.js";

export interface Provider {
  capabilities: ModelCapabilities;
  stream(req: StreamRequest): AsyncIterable<ProviderEvent>;
}

export interface ChatStreamChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      /** Some proxies (AMD Radeon API) stream thinking here instead. */
      reasoning?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    cached_tokens?: number;
    input_tokens?: number;
    output_tokens?: number;
    reasoning_tokens?: number;
    completion_tokens_details?: { reasoning_tokens?: number };
  };
}

interface ToolAcc {
  id: string;
  name: string;
  arguments: string;
  started: boolean;
}

/** Fold one chat-completions stream chunk into normalized events. */
export function chatChunkToEvents(chunk: ChatStreamChunk, tools: Map<number, ToolAcc>): ProviderEvent[] {
  const events: ProviderEvent[] = [];
  const choice = chunk.choices?.[0];
  const delta = choice?.delta;
  if (typeof delta?.content === "string" && delta.content) {
    events.push({ type: "text_delta", text: delta.content });
  }
  if (typeof delta?.reasoning_content === "string" && delta.reasoning_content) {
    events.push({ type: "thinking_delta", text: delta.reasoning_content });
  }
  if (typeof delta?.reasoning === "string" && delta.reasoning) {
    events.push({ type: "thinking_delta", text: delta.reasoning });
  }
  for (const call of delta?.tool_calls ?? []) {
    const index = call.index ?? 0;
    let acc = tools.get(index);
    if (!acc) {
      acc = { id: call.id || `call-${index}`, name: call.function?.name ?? "", arguments: "", started: false };
      tools.set(index, acc);
    }
    if (call.id) acc.id = call.id;
    if (call.function?.name) acc.name = call.function.name;
    if (!acc.started && acc.name) {
      acc.started = true;
      events.push({ type: "tool_call_start", id: acc.id, name: acc.name });
    }
    if (call.function?.arguments) {
      acc.arguments += call.function.arguments;
      events.push({ type: "tool_call_delta", id: acc.id, argumentsDelta: call.function.arguments });
    }
  }
  if (chunk.usage) {
    const u = chunk.usage;
    const reasoning =
      u.reasoning_tokens ?? u.completion_tokens_details?.reasoning_tokens ?? null;
    events.push({
      type: "usage",
      input: u.prompt_tokens ?? u.input_tokens ?? 0,
      output: u.completion_tokens ?? u.output_tokens ?? 0,
      cachedInput: u.cached_tokens,
      reasoningTokens: typeof reasoning === "number" ? reasoning : null,
      usageEstimated: false,
    });
  }
  if (choice?.finish_reason) {
    for (const acc of tools.values()) {
      events.push({
        type: "tool_call_end",
        id: acc.id,
        name: acc.name || "unknown",
        arguments: acc.arguments || "{}",
      });
    }
    tools.clear();
    events.push({ type: "stop", finishReason: choice.finish_reason });
  }
  return events;
}

export async function* streamChatChunks(source: AsyncIterable<ChatStreamChunk>): AsyncGenerator<ProviderEvent> {
  const tools = new Map<number, ToolAcc>();
  for await (const chunk of source) {
    for (const event of chatChunkToEvents(chunk, tools)) yield event;
  }
}

/** Collapse a provider stream into the legacy non-streaming result. */
export async function collectProviderEvents(events: AsyncIterable<ProviderEvent>): Promise<ResponsesCreateResult> {
  let text = "";
  let thinking = "";
  let finish_reason: string | undefined;
  let usage: ResponsesCreateResult["usage"];
  let sawUsage = false;
  const output: ResponsesCreateResult["output"] = [];
  const calls = new Map<string, { name: string; arguments: string }>();

  for await (const event of events) {
    switch (event.type) {
      case "text_delta":
        text += event.text;
        break;
      case "thinking_delta":
        thinking += event.text;
        break;
      case "tool_call_start":
        calls.set(event.id, { name: event.name, arguments: "" });
        break;
      case "tool_call_delta": {
        const acc = calls.get(event.id) ?? { name: "unknown", arguments: "" };
        acc.arguments += event.argumentsDelta;
        calls.set(event.id, acc);
        break;
      }
      case "tool_call_end":
        calls.set(event.id, { name: event.name, arguments: event.arguments });
        break;
      case "usage":
        sawUsage = true;
        usage = {
          input: event.input,
          output: event.output,
          cachedInput: event.cachedInput,
          reasoningTokens: event.reasoningTokens ?? null,
          usageEstimated: event.usageEstimated ?? false,
        };
        break;
      case "stop":
        finish_reason = event.finishReason;
        break;
      default:
        break;
    }
  }

  if (text) output.push({ type: "message", content: text });
  for (const [id, call] of calls) {
    try {
      if (call.arguments.trim()) JSON.parse(call.arguments);
    } catch {
      throw new Error(`Chat stream truncated mid-tool-call (${call.name}); retryable`);
    }
    output.push({ type: "function_call", call_id: id, name: call.name, arguments: call.arguments });
  }
  if (output.length === 0 && finish_reason === undefined) {
    throw new Error("Chat stream ended with no output (truncated); retryable");
  }

  if (!sawUsage) {
    // Provider omitted usage: estimate from text, never store silent 0.
    const est = Math.max(1, Math.round(text.length / 4));
    usage = { input: 0, output: est, reasoningTokens: null, usageEstimated: true };
  } else if (usage && usage.reasoningTokens === undefined) {
    usage.reasoningTokens = null;
  }

  return {
    output,
    output_text: text,
    reasoning_text: thinking.trim() || undefined,
    finish_reason,
    usage,
  };
}

/** Adapter so existing Agent tests keep calling a Responder during the migration. */
export function providerToResponder(provider: Provider, system = ""): (input: unknown[], options?: { tools?: boolean; exclude?: string[]; signal?: AbortSignal }) => Promise<ResponsesCreateResult> {
  return async (input, options) =>
    collectProviderEvents(
      provider.stream({
        system,
        messages: input,
        tools: options?.tools ?? true,
        exclude: options?.exclude,
        signal: options?.signal,
      }),
    );
}

export function scriptedProvider(events: ProviderEvent[], capabilities: ModelCapabilities = CONSERVATIVE_CAPABILITIES): Provider {
  return {
    capabilities,
    async *stream() {
      for (const event of events) yield event;
    },
  };
}

/**
 * F-1: wrap a Provider to report time-to-first-token — ms from stream start
 * to the first text/thinking/tool event (the UI-overhead-to-first-token
 * metric in §7). A stream with no content events reports its total time at
 * the end. The callback never throws into the stream.
 */
export function withFirstTokenTiming(provider: Provider, onFirstToken: (ms: number) => void): Provider {
  return {
    capabilities: provider.capabilities,
    async *stream(req: StreamRequest): AsyncGenerator<ProviderEvent> {
      const start = Date.now();
      let reported = false;
      const report = (): void => {
        if (reported) return;
        reported = true;
        try {
          onFirstToken(Date.now() - start);
        } catch {
          // timing must never break the stream
        }
      };
      for await (const event of provider.stream(req)) {
        if (event.type === "text_delta" || event.type === "thinking_delta" || event.type === "tool_call_start") {
          report();
        }
        yield event;
      }
      report();
    },
  };
}
