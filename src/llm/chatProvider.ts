import type OpenAI from "openai";
import { toChatTools } from "./tools.js";
import type { ResponsesCreateResult, Responder, ResponderOptions } from "./client.js";
import { collectProviderEvents, streamChatChunks, type ChatStreamChunk, type Provider } from "./stream.js";
import type { ProviderEvent, StreamRequest } from "./events.js";
import { getModelCapabilities } from "./capabilities.js";
import { withProviderRetry } from "./retry.js";

/**
 * Chat Completions provider — the free-model route.
 *
 * Any OpenAI-compatible endpoint works here: Ollama, LM Studio, vLLM,
 * Groq, OpenRouter, Gemini's OpenAI-compat endpoint, DeepSeek, etc.
 * The agent loop is untouched: this responder translates the shared
 * Responses-style history into chat messages on every turn and maps
 * the chat result back to { output, output_text }.
 */

type ChatMessage = OpenAI.ChatCompletionMessageParam;
type ChatTool = OpenAI.ChatCompletionTool;

/** Narrow structural client so tests can inject a fake. */
export interface MinimalChatClient {
  chat: {
    completions: {
      create(body: {
        model: string;
        messages: ChatMessage[];
        tools?: ChatTool[];
        stream?: boolean;
      }): Promise<
        | {
            choices: Array<{
              message: {
                content?: string | null;
                reasoning_content?: string | null;
                reasoning?: string | null;
                thought?: string | null;
                tool_calls?: Array<{
                  id: string;
                  type?: string;
                  function: { name: string; arguments: string };
                }>;
              };
              finish_reason?: string | null;
            }>;
          }
        | AsyncIterable<ChatStreamChunk>
      >;
    };
  };
}

function isAsyncIterable(value: unknown): value is AsyncIterable<ChatStreamChunk> {
  return typeof value === "object" && value !== null && Symbol.asyncIterator in value;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function extractMessageText(item: Record<string, unknown>): string {
  const content = item.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter(isRecord)
      .filter((p) => p.type === "output_text" || p.type === "text")
      .map((p) => (typeof p.text === "string" ? p.text : ""))
      .join("");
  }
  return "";
}

/**
 * Convert the agent's Responses-style history into chat messages.
 * Handles: {role,user} items, function_call / function_call_output
 * pairs, message items carrying assistant text, and skips anything
 * the chat API cannot represent (reasoning items, etc.).
 * AG-15: mixed text/image user content is preserved as OpenAI
 * [{type:"text"}|{type:"image_url"}] parts.
 */
export function responsesHistoryToChatMessages(input: unknown[]): ChatMessage[] {
  const messages: ChatMessage[] = [];
  let pendingText = "";
  let pendingCalls: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }> = [];

  const flushAssistant = (): void => {
    if (!pendingText && pendingCalls.length === 0) return;
    messages.push({
      role: "assistant",
      content: pendingText || null,
      ...(pendingCalls.length > 0 ? { tool_calls: pendingCalls } : {}),
    } as ChatMessage);
    pendingText = "";
    pendingCalls = [];
  };

  for (const raw of input) {
    if (!isRecord(raw)) continue;

    if (raw.type === "function_call") {
      pendingCalls.push({
        id: String(raw.call_id ?? `call-${pendingCalls.length}`),
        type: "function",
        function: {
          name: String(raw.name ?? "unknown"),
          arguments: typeof raw.arguments === "string" ? raw.arguments : "{}",
        },
      });
      continue;
    }

    if (raw.type === "function_call_output") {
      // tool_calls must precede their tool responses.
      flushAssistant();
      messages.push({
        role: "tool",
        tool_call_id: String(raw.call_id ?? ""),
        content: String(raw.output ?? ""),
      } as ChatMessage);
      continue;
    }

    if (raw.type === "message") {
      const text = extractMessageText(raw);
      if (text) pendingText += (pendingText ? "\n" : "") + text;
      continue;
    }

    if (raw.role === "user" || raw.role === "system") {
      flushAssistant();
      const content = (raw as { content?: unknown }).content;
      // AG-15: preserve mixed text/image arrays for vision models.
      if (Array.isArray(content)) {
        const parts: Array<{ type: string; text?: string; image_url?: { url: string } }> = [];
        for (const p of content as Array<Record<string, unknown>>) {
          if (!isRecord(p)) continue;
          if (typeof p.text === "string" && (p.type === "input_text" || p.type === "text")) {
            parts.push({ type: "text", text: p.text as string });
          } else if (typeof p.text === "string" && !p.type) {
            parts.push({ type: "text", text: p.text as string });
          } else if (p.type === "input_image" || p.type === "image_url") {
            const inner = p.image_url as { url?: string } | undefined;
            const url = typeof inner?.url === "string" ? inner.url
              : typeof p.image_url === "string" ? (p.image_url as string)
              : typeof p.data === "string" ? `data:${String(p.media_type ?? "image/png")};base64,${p.data as string}` : null;
            if (url) parts.push({ type: "image_url", image_url: { url } });
          }
        }
        messages.push({ role: raw.role, content: parts as unknown as string } as ChatMessage);
        continue;
      }
      messages.push({
        role: raw.role,
        content: typeof raw.content === "string" ? raw.content : String(raw.content ?? ""),
      } as ChatMessage);
      continue;
    }

    if (raw.role === "assistant") {
      flushAssistant();
      if (typeof raw.content === "string" && raw.content) {
        messages.push({ role: "assistant", content: raw.content });
      }
      continue;
    }

    // Unknown item (reasoning, etc.) — not representable in chat history.
  }

  flushAssistant();
  return messages;
}

/**
 * Extracts model thinking / reasoning text from a chat response message.
 * Supports:
 * - message.reasoning_content (DeepSeek-R1, Groq, Ollama, OpenRouter, vLLM)
 * - message.reasoning (OpenRouter, Together)
 * - message.thought (Gemini compat)
 * - <think>...</think>, <thought>...</thought>, <thinking>...</thinking> tags inside content
 * - Text generated alongside tool_calls (represents the model's rationale before tool execution)
 */
export function extractThinking(msg: {
  content?: string | null;
  reasoning_content?: string | null;
  reasoning?: string | null;
  thought?: string | null;
  tool_calls?: unknown[];
}): { content: string; thinking?: string } {
  const parts: string[] = [];
  let content = msg.content ?? "";

  // 1. Direct reasoning fields
  if (typeof msg.reasoning_content === "string" && msg.reasoning_content.trim()) {
    parts.push(msg.reasoning_content.trim());
  }
  if (typeof msg.reasoning === "string" && msg.reasoning.trim()) {
    parts.push(msg.reasoning.trim());
  }
  if (typeof msg.thought === "string" && msg.thought.trim()) {
    parts.push(msg.thought.trim());
  }

  // 2. Extract <think>...</think>, <thought>...</thought>, or <thinking>...</thinking>
  const thinkRegex = /<(think|thought|thinking)>([\s\S]*?)<\/\1>/gi;
  let match: RegExpExecArray | null;
  while ((match = thinkRegex.exec(content)) !== null) {
    if (match[2].trim()) {
      parts.push(match[2].trim());
    }
  }
  content = content.replace(thinkRegex, "").trim();

  // 3. Handle unclosed <think> tag (in case of stream cutoff)
  const unclosedThink = /<(think|thought|thinking)>([\s\S]*)$/i;
  const unclosedMatch = unclosedThink.exec(content);
  if (unclosedMatch) {
    if (unclosedMatch[2].trim()) {
      parts.push(unclosedMatch[2].trim());
    }
    content = content.replace(unclosedThink, "").trim();
  }

  // 4. If tools are called and content has text, that text is the model's pre-tool thought
  if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0 && content) {
    parts.push(content);
  }

  const thinking = parts.join("\n\n").trim();
  return {
    content,
    thinking: thinking || undefined,
  };
}

/**
 * Systems living in history (repo context, memory) must be folded into the
 * single provider system string: some OpenAI-compat endpoints return an
 * empty stream when more than one system message is present, and native
 * Anthropic/Gemini requests carry system outside `messages` (ML-1/ML-9).
 */
export function extractHistorySystems(messages: Array<{ role?: string; content?: unknown }>): string[] {
  const out: string[] = [];
  for (const m of messages) {
    if (m?.role === "system" && typeof m.content === "string" && m.content) out.push(m.content);
  }
  return out;
}
/**
 * Minimal SSE parser for Chat Completions streams (ML-1).
 * Kept local (instead of reusing anthropic.ts's parseSseStream) so this
 * module stays importable from anthropic.ts/gemini.ts without a cycle.
 * Skips `[DONE]` sentinels and truncated-JSON frames, like the other adapters.
 */
export async function* parseChatSse(
  stream: ReadableStream<Uint8Array> | AsyncIterable<string | Uint8Array>,
): AsyncGenerator<ChatStreamChunk> {
  const textChunks: string[] = [];
  // Same live-SSE fix as parseSseStream: Node 22 web streams async-iterate
  // Uint8Array chunks, which String() would corrupt into "104,101,...".
  const decoder = new TextDecoder();
  if (Symbol.asyncIterator in Object(stream)) {
    for await (const part of stream as AsyncIterable<string | Uint8Array>) {
      textChunks.push(typeof part === "string" ? part : decoder.decode(part, { stream: true }));
    }
    textChunks.push(decoder.decode());
  } else {
    const reader = (stream as ReadableStream<Uint8Array>).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      textChunks.push(decoder.decode(value, { stream: true }));
    }
    textChunks.push(decoder.decode());
  }
  const raw = textChunks.join("");
  for (const block of raw.split(/\n\n+/)) {
    const dataLines: string[] = [];
    let isErrorEvent = false;
    for (const line of block.split("\n")) {
      if (line.startsWith("event:") && line.slice(6).trim() === "error") isErrorEvent = true;
      if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    if (dataLines.length === 0) continue;
    const dataRaw = dataLines.join("\n");
    if (dataRaw === "[DONE]") continue;
    try {
      const parsed = JSON.parse(dataRaw) as ChatStreamChunk & { error?: { message?: string } };
      if (isErrorEvent || parsed.error) {
        const msg = parsed.error?.message ?? dataRaw;
        throw new Error(`Chat upstream error: ${msg}`);
      }
      yield parsed;
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("Chat upstream error:")) throw e;
      // Truncated JSON frame — same fault-injection tolerance as other adapters.
    }
  }
}

export interface ChatStreamOptions {
  model: string;
  apiKey: string;
  baseURL?: string;
  systemPrompt?: string;
  fetchImpl?: typeof fetch;
}

/**
 * Native Chat Completions streaming provider (ML-1): POST
 * `{baseURL}/chat/completions` with `stream: true`.
 * Covers Ollama, Groq, OpenRouter, Gemini-compat and any other
 * OpenAI-compatible endpoint with true incremental deltas, so the
 * chat/compat backend is no longer responder-only.
 */
export function createChatStreamProvider(opts: ChatStreamOptions): Provider {
  const base = (opts.baseURL ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  const fetchImpl = opts.fetchImpl ?? fetch;
  return {
    capabilities: getModelCapabilities(opts.model),
    async *stream(req: StreamRequest): AsyncGenerator<ProviderEvent> {
      const history = responsesHistoryToChatMessages(req.messages);
      // One system message total: history systems (repo context, memory)
      // fold into the head — extra system messages make some compat
      // endpoints return an empty stream (observed live, Qwen via proxy).
      const extraSystem = extractHistorySystems(history as Array<{ role?: string; content?: unknown }>);
      const rest = history.filter(
        (m) => (m as { role?: string }).role !== "system" || typeof (m as { content?: unknown }).content !== "string",
      );
      const head = [opts.systemPrompt, req.system, ...extraSystem].filter(Boolean).join("\n\n");
      const messages: ChatMessage[] = [
        ...(head ? [{ role: "system", content: head } as ChatMessage] : []),
        ...rest,
      ];
      const res = await withProviderRetry(() =>
        fetchImpl(`${base}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${opts.apiKey}` },
          body: JSON.stringify({
            model: opts.model,
            messages,
            tools: req.tools ? (toChatTools() as unknown as ChatTool[]) : undefined,
            stream: true,
          }),
          signal: req.signal,
        }).then(async (r) => {
          if (!r.ok) {
            const text = await r.text().catch(() => "");
            const err = new Error(`Chat ${r.status}: ${text.slice(0, 300)}`) as Error & { status?: number };
            (err as { status?: number }).status = r.status;
            throw err;
          }
          return r;
        }),
      );
      if (!res.body) throw new Error("Chat stream had no body.");
      yield* streamChatChunks(parseChatSse(res.body as ReadableStream<Uint8Array>));
      if (req.signal?.aborted) throw new Error("Provider request cancelled (AbortSignal).");
    },
  };
}

export function createChatResponder(
  client: MinimalChatClient,
  args: { model: string; systemPrompt: string },
): Responder {
  return async (input: unknown[], options?: ResponderOptions) => {
    const history = responsesHistoryToChatMessages(input);
    const extraSystem = extractHistorySystems(history as Array<{ role?: string; content?: unknown }>);
    const rest = history.filter(
      (m) => (m as { role?: string }).role !== "system" || typeof (m as { content?: unknown }).content !== "string",
    );
    const head = [args.systemPrompt, ...extraSystem].filter(Boolean).join("\n\n");
    const messages: ChatMessage[] = [...(head ? [{ role: "system", content: head } as ChatMessage] : []), ...rest];

    const useTools = options?.tools ?? true;
    const created = await withProviderRetry(() =>
      client.chat.completions.create({
        model: args.model,
        messages,
        stream: true,
        ...(useTools ? { tools: toChatTools() as unknown as ChatTool[] } : {}),
      }),
    );
    if (isAsyncIterable(created)) {
      return collectProviderEvents(streamChatChunks(created));
    }

    const completion = created;
    const choice = completion.choices[0];
    const msg = choice?.message;
    if (!msg) throw new Error("Chat provider returned no choices.");

    const { content: text, thinking } = extractThinking(msg);
    const finish_reason = (choice as { finish_reason?: string })?.finish_reason;
    const output: ResponsesCreateResult["output"] = [];
    if (text) output.push({ type: "message", content: text });
    for (const tc of msg.tool_calls ?? []) {
      output.push({
        type: "function_call",
        call_id: tc.id,
        name: tc.function.name,
        arguments: tc.function.arguments,
      });
    }
    return { output, output_text: text, reasoning_text: thinking, finish_reason };
  };
}
