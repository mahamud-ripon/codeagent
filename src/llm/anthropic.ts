import type { ProviderEvent, StreamRequest } from "./events.js";
import type { Provider } from "./stream.js";
import { getModelCapabilities } from "./capabilities.js";
import { withProviderRetry } from "./retry.js";
import { toChatTools } from "./tools.js";
import { responsesHistoryToChatMessages } from "./chatProvider.js";
import { streamChatChunks, type ChatStreamChunk } from "./stream.js";

interface AnthropicStreamChunk {
  type: string;
  delta?: { type?: string; text?: string; partial_json?: string; thinking?: string };
  content_block?: { type?: string; id?: string; name?: string };
  index?: number;
  message?: { usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number } };
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number };
}

interface ToolAcc {
  id: string;
  name: string;
  arguments: string;
  started: boolean;
}

/** Fold one Anthropic Messages SSE JSON payload into normalized events. Pure, unit-tested. */
export function anthropicChunkToEvents(chunk: AnthropicStreamChunk, tools: Map<number, ToolAcc>): ProviderEvent[] {
  const events: ProviderEvent[] = [];
  const t = chunk.type;
  if (t === "content_block_start") {
    const idx = chunk.index ?? 0;
    const block = chunk.content_block;
    if (block?.type === "tool_use") {
      const acc: ToolAcc = { id: String((block as { id?: string }).id ?? `call-${idx}`), name: String((block as { name?: string }).name ?? ""), arguments: "", started: true };
      tools.set(idx, acc);
      if (acc.name) events.push({ type: "tool_call_start", id: acc.id, name: acc.name });
    }
    return events;
  }
  if (t === "content_block_delta") {
    const d = chunk.delta;
    if (d?.type === "text_delta" && typeof d.text === "string" && d.text) {
      events.push({ type: "text_delta", text: d.text });
    } else if (d?.type === "thinking_delta" && typeof d.thinking === "string" && d.thinking) {
      events.push({ type: "thinking_delta", text: d.thinking });
    } else if (d?.type === "input_json_delta" && typeof d.partial_json === "string" && d.partial_json) {
      const idx = chunk.index ?? 0;
      let acc = tools.get(idx);
      if (!acc) {
        acc = { id: `call-${idx}`, name: "unknown", arguments: "", started: false };
        tools.set(idx, acc);
      }
      acc.arguments += d.partial_json;
      events.push({ type: "tool_call_delta", id: acc.id, argumentsDelta: d.partial_json });
    }
    return events;
  }
  if (t === "content_block_stop") {
    return events;
  }
  if (t === "message_delta") {
    return events;
  }
  if (t === "message_stop") {
    for (const acc of tools.values()) {
      events.push({ type: "tool_call_end", id: acc.id, name: acc.name || "unknown", arguments: acc.arguments || "{}" });
    }
    tools.clear();
    events.push({ type: "stop", finishReason: "stop" });
    return events;
  }
  const usage = chunk.usage ?? chunk.message?.usage;
  if (usage && (usage.input_tokens !== undefined || usage.output_tokens !== undefined)) {
    events.push({
      type: "usage",
      input: usage.input_tokens ?? 0,
      output: usage.output_tokens ?? 0,
      cachedInput: usage.cache_read_input_tokens,
    });
  }
  return events;
}

export async function* streamAnthropicChunks(source: AsyncIterable<AnthropicStreamChunk>): AsyncGenerator<ProviderEvent> {
  const tools = new Map<number, ToolAcc>();
  for await (const chunk of source) {
    for (const e of anthropicChunkToEvents(chunk, tools)) yield e;
  }
}

function toAnthropicTools(): Array<{ name: string; description?: string; input_schema: unknown }> {
  // Reuse the shared Responses tool defs, translated to Anthropic input_schema.
  // Import lazily to avoid cycles at module load.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const defs = (toChatTools() as Array<{ function: { name: string; description?: string; parameters?: unknown } }>).map(
    (t) => ({ name: t.function.name, description: t.function.description, input_schema: t.function.parameters ?? { type: "object" } }),
  );
  return defs;
}

function toAnthropicMessages(input: unknown[]): Array<{ role: string; content: unknown }> {
  const chat = responsesHistoryToChatMessages(input);
  return chat
    .filter((m) => m.role !== "system")
    .map((m) => {
      if (m.role === "tool") {
        const t = m as { tool_call_id?: string; content?: unknown };
        return { role: "user", content: [{ type: "tool_result", tool_use_id: t.tool_call_id, content: String(t.content ?? "") }] };
      }
      if (m.role === "assistant") {
        const a = m as { content?: unknown; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> };
        if (a.tool_calls?.length) {
          const blocks: unknown[] = [];
          if (typeof a.content === "string" && a.content) blocks.push({ type: "text", text: a.content });
          for (const tc of a.tool_calls) {
            let parsed: unknown = {};
            try { parsed = JSON.parse(tc.function.arguments); } catch { parsed = {}; }
            blocks.push({ type: "tool_use", id: tc.id, name: tc.function.name, input: parsed });
          }
          return { role: "assistant", content: blocks };
        }
      }
      return { role: m.role, content: m.content };
    });
}

/** Parse an SSE byte stream into JSON payloads (used by Anthropic/Gemini/Responses). */
export async function* parseSseStream(stream: ReadableStream<Uint8Array> | AsyncIterable<string>): AsyncGenerator<{ event: string; data: unknown }> {
  const textChunks: string[] = [];
  if (Symbol.asyncIterator in Object(stream)) {
    for await (const part of stream as AsyncIterable<string>) textChunks.push(String(part));
  } else {
    const reader = (stream as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      textChunks.push(decoder.decode(value, { stream: true }));
    }
    textChunks.push(new TextDecoder().decode());
  }
  const raw = textChunks.join("");
  const blocks = raw.split(/\n\n+/);
  for (const block of blocks) {
    let event = "message";
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    if (dataLines.length === 0) continue;
    const dataRaw = dataLines.join("\n");
    if (dataRaw === "[DONE]") continue;
    try {
      yield { event, data: JSON.parse(dataRaw) };
    } catch {
      // Truncated JSON in a stream is a fault-injection case; skip the frame.
    }
  }
}

export interface AnthropicProviderOptions {
  model: string;
  apiKey: string;
  baseURL?: string;
  systemPrompt?: string;
  fetchImpl?: typeof fetch;
}

/** Native Anthropic Messages adapter implementing Provider.stream (ML-1). */
export function createAnthropicProvider(opts: AnthropicProviderOptions): Provider {
  const base = (opts.baseURL ?? "https://api.anthropic.com").replace(/\/+$/, "");
  const fetchImpl = opts.fetchImpl ?? fetch;
  return {
    capabilities: getModelCapabilities(opts.model),
    async *stream(req: StreamRequest): AsyncGenerator<ProviderEvent> {
      const body = {
        model: opts.model,
        system: [opts.systemPrompt, req.system].filter(Boolean).join("\n\n") || undefined,
        messages: toAnthropicMessages(req.messages),
        tools: req.tools ? toAnthropicTools() : undefined,
        stream: true,
        max_tokens: getModelCapabilities(opts.model).maxOutput,
      };
      const res = await withProviderRetry(() =>
        fetchImpl(`${base}/v1/messages`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": opts.apiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify(body),
          signal: req.signal,
        }).then(async (r) => {
          if (!r.ok) {
            const text = await r.text().catch(() => "");
            const err = new Error(`Anthropic ${r.status}: ${text.slice(0, 300)}`) as Error & { status?: number };
            (err as { status?: number }).status = r.status;
            throw err;
          }
          return r;
        }),
      );
      if (!res.body) throw new Error("Anthropic stream had no body.");
      const tools = new Map<number, ToolAcc>();
      for await (const frame of parseSseStream(res.body as ReadableStream<Uint8Array>)) {
        for (const e of anthropicChunkToEvents(frame.data as AnthropicStreamChunk, tools)) yield e;
        if (req.signal?.aborted) throw new Error("Provider request cancelled (AbortSignal).");
      }
    },
  };
}

// Re-export chat-chunk helper type for contract tests.
export type { ChatStreamChunk };
export { streamChatChunks };
