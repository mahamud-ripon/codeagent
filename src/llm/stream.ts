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
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; cached_tokens?: number };
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
    events.push({
      type: "usage",
      input: chunk.usage.prompt_tokens ?? 0,
      output: chunk.usage.completion_tokens ?? 0,
      cachedInput: chunk.usage.cached_tokens,
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
        usage = { input: event.input, output: event.output, cachedInput: event.cachedInput };
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
    output.push({ type: "function_call", call_id: id, name: call.name, arguments: call.arguments });
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
export function providerToResponder(provider: Provider, system = ""): (input: unknown[], options?: { tools?: boolean }) => Promise<ResponsesCreateResult> {
  return async (input, options) =>
    collectProviderEvents(
      provider.stream({
        system,
        messages: input,
        tools: options?.tools ?? true,
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
