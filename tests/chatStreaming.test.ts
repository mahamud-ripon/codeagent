import { describe, expect, it } from "vitest";
import {
  createChatStreamProvider,
  extractHistorySystems,
  parseChatSse,
} from "../src/llm/chatProvider.js";
import { createStreamingProvider } from "../src/llm/streamingProvider.js";
import { createProviderFromEnv } from "../src/llm/provider.js";
import { scriptedProvider, withFirstTokenTiming } from "../src/llm/stream.js";
import type { ProviderEvent } from "../src/llm/events.js";
import { summarizeLive } from "../eval/score.js";
import { PROMPT_VERSION } from "../src/agent/promptSections.js";

async function collect(events: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

function sseBody(frames: string[]): AsyncIterable<string> {
  return (async function* () {
    for (const f of frames) yield f;
  })();
}

/** Byte-chunk body: what Node 22 fetch bodies actually async-iterate. */
function sseByteBody(frames: string[], splitAt = 7): AsyncIterable<Uint8Array> {
  const enc = new TextEncoder();
  return (async function* () {
    for (const f of frames) {
      const bytes = enc.encode(f);
      // Split mid-frame so no chunk boundary aligns with an SSE line.
      yield bytes.slice(0, splitAt);
      yield bytes.slice(splitAt);
    }
  })();
}

describe("chat SSE streaming (ML-1: chat/compat is no longer responder-only)", () => {
  it("parseChatSse skips [DONE] and truncated frames", async () => {
    const events = await collect(
      (async function* () {
        for await (const chunk of parseChatSse(
          sseBody([
            `data: {"choices":[{"delta":{"content":"hi"}}]}\n\n`,
            "data: [DONE]\n\n",
            "data: {truncated\n\n",
          ]),
        )) {
          yield { type: "text_delta", text: String((chunk.choices?.[0]?.delta as { content?: string })?.content ?? "") };
        }
      })(),
    );
    expect(events).toEqual([{ type: "text_delta", text: "hi" }]);
  });

  it("parseChatSse decodes Uint8Array chunks (Node 22 live bodies)", async () => {
    const chunks: unknown[] = [];
    for await (const chunk of parseChatSse(
      sseByteBody([
        `data: {"choices":[{"delta":{"content":"hel"}}]}\n\n`,
        `data: {"choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}]}\n\n`,
        "data: [DONE]\n\n",
      ]),
    )) {
      chunks.push(chunk);
    }
    expect(chunks).toHaveLength(2);
    expect((chunks[0] as { choices: Array<{ delta: { content: string } }> }).choices[0].delta.content).toBe("hel");
    expect((chunks[1] as { choices: Array<{ finish_reason: string }> }).choices[0].finish_reason).toBe("stop");
  });

  it("createChatStreamProvider posts stream:true and folds deltas", async () => {
    let url = "";
    let body: Record<string, unknown> = {};
    let auth = "";
    const fetchImpl = (async (u: string, init: { headers?: Record<string, string>; body?: string }) => ({
      ok: true,
      text: async () => "",
      body: sseBody([
        `data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n`,
        `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"read","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}\n\n`,
        "data: [DONE]\n\n",
      ]),
    })) as unknown as typeof fetch;
    const wrappedFetch = (async (u: unknown, init: unknown) => {
      url = String(u);
      const b = (init as { headers?: Record<string, string>; body?: string }).body ?? "{}";
      body = JSON.parse(b) as Record<string, unknown>;
      auth = String((init as { headers?: Record<string, string> }).headers?.authorization ?? "");
      return fetchImpl(String(u), init as { headers?: Record<string, string>; body?: string });
    }) as unknown as typeof fetch;

    const provider = createChatStreamProvider({
      model: "test-model",
      apiKey: "k",
      baseURL: "http://localhost:11434/v1/",
      systemPrompt: "sys",
      fetchImpl: wrappedFetch,
    });
    const events = await collect(provider.stream({ system: "", messages: [{ role: "user", content: "hi" }], tools: true }));
    expect(url).toBe("http://localhost:11434/v1/chat/completions");
    expect(body.stream).toBe(true);
    expect(auth).toBe("Bearer k");
    expect(JSON.stringify((body.messages as unknown[])[0])).toContain("sys");
    expect(events).toContainEqual({ type: "text_delta", text: "Hello" });
    expect(events).toContainEqual({ type: "tool_call_start", id: "call-1", name: "read" });
    expect(events).toContainEqual({ type: "tool_call_end", id: "call-1", name: "read", arguments: "{}" });
    expect(events).toContainEqual({ type: "stop", finishReason: "tool_calls" });
  });

  it("chat auth errors surface with status", async () => {
    const bad = (async () => ({ ok: false, status: 401, text: async () => "bad key" })) as unknown as typeof fetch;
    const provider = createChatStreamProvider({ model: "m", apiKey: "bad", fetchImpl: bad });
    await expect(collect(provider.stream({ system: "", messages: [], tools: false }))).rejects.toThrow(/401/);
  });

  it("factory returns a live chat streamer, not an empty stub", async () => {
    const provider = createStreamingProvider({
      kind: "openai-chat",
      model: "test-model",
      apiKey: "k",
      baseURL: "http://example.test/v1",
      fetchImpl: (async () => ({
        ok: true,
        text: async () => "",
        body: sseBody([`data: {"choices":[{"delta":{"content":"yo"}}]}\n\n`, "data: [DONE]\n\n"]),
      })) as unknown as typeof fetch,
    });
    const events = await collect(provider.stream({ system: "", messages: [], tools: false }));
    expect(events).toContainEqual({ type: "text_delta", text: "yo" });
  });

  it("provider factory returns a streaming instance for chat/compat", () => {
    const local = createProviderFromEnv(
      { OPENAI_BASE_URL: "http://localhost:11434/v1", OPENAI_API_KEY: "x" } as NodeJS.ProcessEnv,
      { model: "ollama/llama3" },
    );
    expect(local.info.kind).toBe("openai-chat");
    expect(local.providerInstance).toBeDefined();
    const explicit = createProviderFromEnv({ OPENAI_API_KEY: "x" } as NodeJS.ProcessEnv, {
      model: "gpt-5.6-luna",
      provider: "chat",
    });
    expect(explicit.providerInstance).toBeDefined();
  });

  it("folds history systems into one leading system message", async () => {
    // Live find: extra system messages make some compat endpoints return
    // an empty stream — the request must carry exactly one system message.
    let body: Record<string, unknown> = {};
    const fetchImpl = (async (_u: string, init: { body?: string }) => ({
      ok: true,
      text: async () => "",
      body: sseBody([`data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n`]),
    })) as unknown as typeof fetch;
    const wrappedFetch = (async (u: unknown, init: unknown) => {
      body = JSON.parse((init as { body?: string }).body ?? "{}") as Record<string, unknown>;
      return fetchImpl(String(u), init as { body?: string });
    }) as unknown as typeof fetch;
    const provider = createChatStreamProvider({
      model: "test-model",
      apiKey: "k",
      baseURL: "http://x.test/v1",
      systemPrompt: "SYS",
      fetchImpl: wrappedFetch,
    });
    await collect(
      provider.stream({
        system: "REQ",
        messages: [
          { role: "system", content: "<repository>ctx</repository>" },
          { role: "user", content: "hi" },
        ],
        tools: false,
      }),
    );
    const messages = body.messages as Array<{ role: string; content: string }>;
    const systems = messages.filter((m) => m.role === "system");
    expect(systems).toHaveLength(1);
    expect(systems[0].content).toBe("SYS\n\nREQ\n\n<repository>ctx</repository>");
    expect(messages[messages.length - 1]).toMatchObject({ role: "user", content: "hi" });
  });

  it("extractHistorySystems picks string systems only", () => {
    expect(
      extractHistorySystems([
        { role: "system", content: "a" },
        { role: "user", content: "hi" },
        { role: "system", content: "" },
        { role: "system", content: ["parts"] },
      ]),
    ).toEqual(["a"]);
  });
});

describe("first-token timing (F-1)", () => {
  it("reports once on the first content event", async () => {
    const seen: number[] = [];
    const wrapped = withFirstTokenTiming(
      scriptedProvider([
        { type: "tool_call_start", id: "a", name: "read" },
        { type: "text_delta", text: "hi" },
        { type: "stop", finishReason: "stop" },
      ]),
      (ms) => {
        seen.push(ms);
      },
    );
    const events = await collect(wrapped.stream({ system: "", messages: [], tools: true }));
    expect(events.length).toBe(3);
    expect(seen.length).toBe(1);
    expect(seen[0]).toBeGreaterThanOrEqual(0);
  });

  it("a throwing callback never breaks the stream", async () => {
    const wrapped = withFirstTokenTiming(scriptedProvider([{ type: "text_delta", text: "z" }]), () => {
      throw new Error("timer broke");
    });
    const events = await collect(wrapped.stream({ system: "", messages: [], tools: false }));
    expect(events).toEqual([{ type: "text_delta", text: "z" }]);
  });
});

describe("live scoring carries ttft + prompt version (F-1/F-8)", () => {
  it("summarizes median ttft and pins the prompt version", () => {
    const s = summarizeLive([
      { taskId: "a", ok: true, turns: 3, inputTokens: 1, outputTokens: 1, costUsd: 0, seconds: 1, ttftMs: 100 },
      { taskId: "b", ok: true, turns: 3, inputTokens: 1, outputTokens: 1, costUsd: 0, seconds: 1, ttftMs: 300 },
      { taskId: "c", ok: false, turns: 1, inputTokens: 0, outputTokens: 0, costUsd: 0, seconds: 1 },
    ]);
    expect(s.medianTtftMs).toBe(300);
    expect(s.promptVersion).toBe(PROMPT_VERSION);
  });
});
