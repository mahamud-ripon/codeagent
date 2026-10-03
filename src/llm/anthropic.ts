import type { ProviderEvent, StreamRequest } from "./events.js";
import type { Provider } from "./stream.js";
import { getModelCapabilities } from "./capabilities.js";
import { withProviderRetry } from "./retry.js";
import { toChatTools } from "./tools.js";
import {
  extractHistorySystems,
  responsesHistoryToChatMessages,
} from "./chatProvider.js";
import { streamChatChunks, type ChatStreamChunk } from "./stream.js";
import {
  orderPrefixParts,
  supportsPromptCaching,
  withAnthropicCacheBreakpoints,
} from "./cache.js";

interface AnthropicStreamChunk {
  type: string;
  delta?: {
    type?: string;
    text?: string;
    partial_json?: string;
    thinking?: string;
  };
  content_block?: { type?: string; id?: string; name?: string };
  index?: number;
  message?: {
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

interface ToolAcc {
  id: string;
  name: string;
  arguments: string;
  started: boolean;
}

/** Fold one Anthropic Messages SSE JSON payload into normalized events. Pure, unit-tested. */
export function anthropicChunkToEvents(
  chunk: AnthropicStreamChunk,
  tools: Map<number, ToolAcc>,
): ProviderEvent[] {
  const events: ProviderEvent[] = [];
  const t = chunk.type;
  if (t === "content_block_start") {
    const idx = chunk.index ?? 0;
    const block = chunk.content_block;
    if (block?.type === "tool_use") {
      const acc: ToolAcc = {
        id: String((block as { id?: string }).id ?? `call-${idx}`),
        name: String((block as { name?: string }).name ?? ""),
        arguments: "",
        started: true,
      };
      tools.set(idx, acc);
      if (acc.name)
        events.push({ type: "tool_call_start", id: acc.id, name: acc.name });
    }
    return events;
  }
  if (t === "content_block_delta") {
    const d = chunk.delta;
    if (d?.type === "text_delta" && typeof d.text === "string" && d.text) {
      events.push({ type: "text_delta", text: d.text });
    } else if (
      d?.type === "thinking_delta" &&
      typeof d.thinking === "string" &&
      d.thinking
    ) {
      events.push({ type: "thinking_delta", text: d.thinking });
    } else if (
      d?.type === "input_json_delta" &&
      typeof d.partial_json === "string" &&
      d.partial_json
    ) {
      const idx = chunk.index ?? 0;
      let acc = tools.get(idx);
      if (!acc) {
        acc = {
          id: `call-${idx}`,
          name: "unknown",
          arguments: "",
          started: false,
        };
        tools.set(idx, acc);
      }
      acc.arguments += d.partial_json;
      events.push({
        type: "tool_call_delta",
        id: acc.id,
        argumentsDelta: d.partial_json,
      });
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
      events.push({
        type: "tool_call_end",
        id: acc.id,
        name: acc.name || "unknown",
        arguments: acc.arguments || "{}",
      });
    }
    tools.clear();
    events.push({ type: "stop", finishReason: "stop" });
    return events;
  }
  const usage = chunk.usage ?? chunk.message?.usage;
  if (
    usage &&
    (usage.input_tokens !== undefined || usage.output_tokens !== undefined)
  ) {
    events.push({
      type: "usage",
      input: usage.input_tokens ?? 0,
      output: usage.output_tokens ?? 0,
      cachedInput: usage.cache_read_input_tokens,
    });
  }
  return events;
}

export async function* streamAnthropicChunks(
  source: AsyncIterable<AnthropicStreamChunk>,
): AsyncGenerator<ProviderEvent> {
  const tools = new Map<number, ToolAcc>();
  for await (const chunk of source) {
    for (const e of anthropicChunkToEvents(chunk, tools)) yield e;
  }
}

function toAnthropicTools(
  exclude?: string[],
  definitions?: import("./events.js").WireTool[],
): Array<{ name: string; description?: string; input_schema: unknown }> {
  // Reuse the shared Responses tool defs, translated to Anthropic input_schema.
  // Import lazily to avoid cycles at module load.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const defs = (
    toChatTools({ exclude, definitions }) as Array<{
      function: { name: string; description?: string; parameters?: unknown };
    }>
  ).map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters ?? { type: "object" },
  }));
  return defs;
}

function toAnthropicMessages(
  input: unknown[],
): Array<{ role: string; content: unknown }> {
  // Stable prefix order (ML-9): system → tools → memory → history is already
  // the agent's construction order; keep it explicit so cache hits are stable.
  void orderPrefixParts;
  const chat = responsesHistoryToChatMessages(input);
  return chat
    .filter((m) => m.role !== "system")
    .map((m) => {
      if (m.role === "tool") {
        const t = m as { tool_call_id?: string; content?: unknown };
        return {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: t.tool_call_id,
              content: String(t.content ?? ""),
            },
          ],
        };
      }
      if (m.role === "assistant") {
        const a = m as {
          content?: unknown;
          tool_calls?: Array<{
            id: string;
            function: { name: string; arguments: string };
          }>;
        };
        if (a.tool_calls?.length) {
          const blocks: unknown[] = [];
          if (typeof a.content === "string" && a.content)
            blocks.push({ type: "text", text: a.content });
          else if (Array.isArray(a.content)) {
            for (const p of a.content as Array<{
              type?: string;
              text?: string;
            }>) {
              if (typeof p?.text === "string" && p.text)
                blocks.push({ type: "text", text: p.text });
            }
          }
          for (const tc of a.tool_calls) {
            let parsed: unknown = {};
            try {
              parsed = JSON.parse(tc.function.arguments);
            } catch {
              parsed = {};
            }
            blocks.push({
              type: "tool_use",
              id: tc.id,
              name: tc.function.name,
              input: parsed,
            });
          }
          return { role: "assistant", content: blocks };
        }
        // Forward image blocks when the chat translator preserved them.
        if (Array.isArray(a.content))
          return { role: "assistant", content: a.content };
      }
      // User content may be a string or a mixed text/image array (AG-15).
      // Anthropic expects [{type:"text"}|{type:"image"}]; pass through blocks.
      if (Array.isArray((m as { content?: unknown }).content)) {
        return { role: m.role, content: (m as { content: unknown }).content };
      }
      return { role: m.role, content: m.content };
    });
}

/** Parse an SSE byte stream into JSON payloads (used by Anthropic/Gemini/Responses). Incremental: yields each complete block as it arrives instead of buffering the whole stream (TTFT + OOM fix). */
export async function* parseSseStream(
  stream: ReadableStream<Uint8Array> | AsyncIterable<string | Uint8Array>,
): AsyncGenerator<{ event: string; data: unknown }> {
  const decoder = new TextDecoder();
  let buffer = "";
  const parseBlock = function* (
    block: string,
  ): Generator<{ event: string; data: unknown }> {
    let event = "message";
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    if (dataLines.length === 0) return;
    const dataRaw = dataLines.join("\n");
    if (dataRaw === "[DONE]") return;
    try {
      yield { event, data: JSON.parse(dataRaw) };
    } catch {
      // Truncated JSON in a stream is a fault-injection case; skip the frame.
    }
  };
  const drainComplete = function* (): Generator<{
    event: string;
    data: unknown;
  }> {
    let idx: number;
    while ((idx = buffer.search(/\n\n/)) !== -1) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      yield* parseBlock(block);
    }
  };
  // Node 22 web streams expose Symbol.asyncIterator yielding Uint8Array
  // chunks — String(chunk) would emit "104,101,..." and silently drop every
  // frame, so byte chunks must go through TextDecoder (live-SSE fix).
  if (Symbol.asyncIterator in Object(stream)) {
    for await (const part of stream as AsyncIterable<string | Uint8Array>) {
      buffer +=
        typeof part === "string"
          ? part
          : decoder.decode(part, { stream: true });
      yield* drainComplete();
    }
    buffer += decoder.decode();
  } else {
    const reader = (stream as ReadableStream<Uint8Array>).getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        yield* drainComplete();
      }
      buffer += decoder.decode();
    } finally {
      reader.releaseLock();
    }
  }
  if (buffer.trim()) {
    yield* parseBlock(buffer);
    buffer = "";
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
export function createAnthropicProvider(
  opts: AnthropicProviderOptions,
): Provider {
  const base = (opts.baseURL ?? "https://api.anthropic.com").replace(
    /\/+$/,
    "",
  );
  const fetchImpl = opts.fetchImpl ?? fetch;
  return {
    capabilities: getModelCapabilities(opts.model),
    async *stream(req: StreamRequest): AsyncGenerator<ProviderEvent> {
      // History systems (repo context, memory) were previously dropped by
      // toAnthropicMessages — fold them into the request system string so
      // the model actually sees them (ML-9 stable prefix, second position).
      const historySystems = extractHistorySystems(
        responsesHistoryToChatMessages(req.messages) as Array<{
          role?: string;
          content?: unknown;
        }>,
      );
      const reqSystem = [req.system, ...historySystems]
        .filter(Boolean)
        .join("\n\n");
      const combinedSystem =
        [opts.systemPrompt, reqSystem].filter(Boolean).join("\n\n") ||
        undefined;
      // ML-9: stable prefix + cache breakpoints for models that support it.
      let system: unknown = combinedSystem;
      if (combinedSystem && supportsPromptCaching(opts.model)) {
        // Split provider system vs request system so the stable prefix
        // (system prompt) can be cached separately from per-turn history.
        const parts = [opts.systemPrompt, reqSystem]
          .filter(Boolean)
          .map((t) => ({ text: String(t) }));
        system = withAnthropicCacheBreakpoints(parts, 2);
      }
      const body = {
        model: opts.model,
        system,
        messages: toAnthropicMessages(req.messages),
        tools: req.tools
          ? toAnthropicTools(req.exclude, req.toolDefinitions)
          : undefined,
        stream: true,
        max_tokens: req.maxOutput ?? getModelCapabilities(opts.model).maxOutput,
      };
      const res = await withProviderRetry(
        () =>
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
              const err = new Error(
                `Anthropic ${r.status}: ${text.slice(0, 300)}`,
              ) as Error & { status?: number };
              (err as { status?: number }).status = r.status;
              throw err;
            }
            return r;
          }),
        // Inner layer only (outer retries whole stream): bound total to 2×3.
        { signal: req.signal, maxAttempts: 2 },
      );
      if (!res.body) throw new Error("Anthropic stream had no body.");
      const tools = new Map<number, ToolAcc>();
      for await (const frame of parseSseStream(
        res.body as ReadableStream<Uint8Array>,
      )) {
        for (const e of anthropicChunkToEvents(
          frame.data as AnthropicStreamChunk,
          tools,
        ))
          yield e;
        if (req.signal?.aborted)
          throw new Error("Provider request cancelled (AbortSignal).");
      }
    },
  };
}

// Re-export chat-chunk helper type for contract tests.
export type { ChatStreamChunk };
export { streamChatChunks };
