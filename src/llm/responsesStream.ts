import type { ProviderEvent, StreamRequest } from "./events.js";
import type { Provider } from "./stream.js";
import { getModelCapabilities } from "./capabilities.js";
import { withProviderRetry } from "./retry.js";
import { parseSseStream } from "./anthropic.js";
import { orderPrefixParts, supportsPromptCaching } from "./cache.js";

interface ResponsesSsePayload {
  type?: string;
  delta?: string | { text?: string };
  text?: string;
  item?: { type?: string; call_id?: string; id?: string; name?: string; arguments?: string };
  response?: { output?: unknown[]; usage?: { input_tokens?: number; output_tokens?: number } };
  usage?: { input_tokens?: number; output_tokens?: number };
}

interface Acc {
  id: string;
  name: string;
  arguments: string;
  started: boolean;
}

/**
 * Fold one OpenAI Responses SSE payload into normalized events (ML-1).
 * Handles `response.output_text.delta`, `response.function_call_arguments.delta`,
 * `response.completed`, and `response.incomplete` frames. Pure, unit-tested.
 */
export function responsesChunkToEvents(payload: ResponsesSsePayload, tools: Map<string, Acc>): ProviderEvent[] {
  const events: ProviderEvent[] = [];
  const t = String(payload.type ?? "");
  const deltaText = typeof payload.delta === "string" ? payload.delta : payload.delta?.text ?? payload.text;
  if ((t === "response.output_text.delta" || t === "response.reasoning_text.delta") && typeof deltaText === "string" && deltaText) {
    events.push(t.includes("reasoning") ? { type: "thinking_delta", text: deltaText } : { type: "text_delta", text: deltaText });
    return events;
  }
  if (t === "response.function_call_arguments.delta" || t === "response.function_call.delta") {
    const item = payload.item ?? {};
    const id = String(item.call_id ?? item.id ?? "call-0");
    let acc = tools.get(id);
    if (!acc) {
      const initialName = typeof item.name === "string" ? item.name : "unknown";
      acc = { id, name: String(initialName), arguments: "", started: false };
      tools.set(id, acc);
    }
    if (item.name) acc.name = String(item.name);
    if (!acc.started && acc.name && acc.name !== "unknown") {
      acc.started = true;
      events.push({ type: "tool_call_start", id: acc.id, name: acc.name });
    }
    if (typeof deltaText === "string" && deltaText) {
      acc.arguments += deltaText;
      events.push({ type: "tool_call_delta", id: acc.id, argumentsDelta: deltaText });
    }
    return events;
  }
  if (t === "response.output_item.done" && payload.item?.type === "function_call") {
    const item = payload.item;
    const id = String(item.call_id ?? item.id ?? "call-0");
    const acc = tools.get(id);
    const name = String(item.name ?? acc?.name ?? "unknown");
    const args = typeof item.arguments === "string" ? item.arguments : (acc?.arguments ?? "{}");
    tools.set(id, { id, name, arguments: args, started: true });
    return events;
  }
  if (t === "response.completed" || t === "response.incomplete" || t === "response.failed") {
    for (const acc of tools.values()) {
      events.push({ type: "tool_call_end", id: acc.id, name: acc.name || "unknown", arguments: acc.arguments || "{}" });
    }
    tools.clear();
    const usage = payload.response?.usage ?? payload.usage;
    if (usage && (usage.input_tokens !== undefined || usage.output_tokens !== undefined)) {
      events.push({ type: "usage", input: usage.input_tokens ?? 0, output: usage.output_tokens ?? 0 });
    }
    const reason = t === "response.incomplete" ? "length" : t === "response.failed" ? "error" : "stop";
    events.push({ type: "stop", finishReason: reason });
    return events;
  }
  return events;
}

export async function* streamResponsesSse(source: AsyncIterable<{ event: string; data: unknown }>): AsyncGenerator<ProviderEvent> {
  const tools = new Map<string, Acc>();
  for await (const frame of source) {
    for (const e of responsesChunkToEvents(frame.data as ResponsesSsePayload, tools)) yield e;
  }
}

export interface ResponsesStreamOptions {
  model: string;
  apiKey: string;
  baseURL?: string;
  instructions?: string;
  fetchImpl?: typeof fetch;
}

/** True streaming Responses provider (ML-1): POST /v1/responses with stream:true. */
export function createResponsesStreamProvider(opts: ResponsesStreamOptions): Provider {
  const base = (opts.baseURL ?? "https://api.openai.com").replace(/\/+$/, "");
  const fetchImpl = opts.fetchImpl ?? fetch;
  return {
    capabilities: getModelCapabilities(opts.model),
    async *stream(req: StreamRequest): AsyncGenerator<ProviderEvent> {
      const { tools } = await import("./tools.js");
      const filtered = req.exclude?.length ? tools.filter((t) => !req.exclude!.includes(t.name)) : tools;
      // ML-9: stable prefix order (system → history) so prompt-cache
      // prefixes stay stable across turns; cache-capable models keep
      // the long system prefix reusable server-side.
      const ordered = orderPrefixParts({
        system: [opts.instructions, req.system].filter(Boolean).join("\n\n") || undefined,
        history: req.messages,
      });
      const systemText = typeof ordered[0] === "object" && ordered[0] !== null
        ? String((ordered[0] as { content?: unknown }).content ?? "")
        : undefined;
      const history = ordered.slice(systemText ? 1 : 0);
      void supportsPromptCaching;
      const res = await withProviderRetry(() =>
        fetchImpl(`${base}/v1/responses`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${opts.apiKey}` },
          body: JSON.stringify({
            model: opts.model,
            instructions: systemText ?? ([opts.instructions, req.system].filter(Boolean).join("\n\n") || undefined),
            input: history.length ? history : req.messages,
            tools: req.tools ? filtered : undefined,
            stream: true,
          }),
          signal: req.signal,
        }).then(async (r) => {
          if (!r.ok) {
            const text = await r.text().catch(() => "");
            const err = new Error(`Responses ${r.status}: ${text.slice(0, 300)}`) as Error & { status?: number };
            (err as { status?: number }).status = r.status;
            throw err;
          }
          return r;
        }),
        // Inner layer only (outer retries whole stream): bound total to 2×3.
        { signal: req.signal, maxAttempts: 2 },
      );
      if (!res.body) throw new Error("Responses stream had no body.");
      yield* streamResponsesSse(parseSseStream(res.body as ReadableStream<Uint8Array>));
      if (req.signal?.aborted) throw new Error("Provider request cancelled (AbortSignal).");
    },
  };
}
