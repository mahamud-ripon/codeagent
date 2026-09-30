import { describe, expect, it } from "vitest";
import { chatChunkToEvents } from "../src/llm/stream.js";
import { anthropicChunkToEvents, createAnthropicProvider, parseSseStream } from "../src/llm/anthropic.js";
import { createGeminiProvider } from "../src/llm/gemini.js";
import { geminiChunkToEvents } from "../src/llm/gemini.js";
import { responsesChunkToEvents } from "../src/llm/responsesStream.js";
import { isRetryableProviderError, parseRetryAfterMs } from "../src/llm/retry.js";

/**
 * QA-4: provider contract tests with recorded streams + fault injection
 * (429, truncated JSON, dropped stream). No network.
 */

const RECORDED_CHAT = [
  { choices: [{ delta: { content: "Hello" } }] },
  { choices: [{ delta: { content: " world" } }] },
  { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "read", arguments: '{"path"' } }] } }] },
  { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':"src/x"}' } }] } }] },
  { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
];

describe("provider contracts + faults", () => {
  it("recorded chat stream replays text + tool call end + stop", () => {
    const tools = new Map();
    const events = RECORDED_CHAT.flatMap((c) => chatChunkToEvents(c as never, tools));
    expect(events[0]).toEqual({ type: "text_delta", text: "Hello" });
    expect(events).toContainEqual({ type: "tool_call_start", id: "c1", name: "read" });
    expect(events[events.length - 1]).toEqual({ type: "stop", finishReason: "tool_calls" });
  });

  it("chat delta.reasoning folds to thinking_delta (proxy variant)", () => {
    const events = chatChunkToEvents(
      { choices: [{ delta: { reasoning: "check the loop" } }] } as never,
      new Map(),
    );
    expect(events).toEqual([{ type: "thinking_delta", text: "check the loop" }]);
  });

  it("429 maps to retryable with Retry-After parsed", () => {
    const err = Object.assign(new Error("429 rate limit"), { status: 429, headers: { "retry-after": "2" } });
    expect(isRetryableProviderError(err)).toBe(true);
    expect(parseRetryAfterMs("2")).toBe(2000);
  });

  it("auth errors never retry", () => {
    expect(isRetryableProviderError(Object.assign(new Error("401 bad key"), { status: 401 }))).toBe(false);
  });

  it("truncated JSON frame is skipped, stream still terminates", () => {
    // A dropped/malformed SSE payload yields no events (parser skips), but a
    // subsequent completed frame still terminates cleanly.
    const tools = new Map<string, { id: string; name: string; arguments: string; started: boolean }>();
    const bad = responsesChunkToEvents({ type: "response.output_text.delta" } as never, tools);
    expect(bad).toEqual([]);
    const end = responsesChunkToEvents({ type: "response.completed" }, tools);
    expect(end[end.length - 1]).toEqual({ type: "stop", finishReason: "stop" });
  });

  it("dropped anthropic stream (no message_stop) yields no phantom stop", () => {
    const tools = new Map();
    const ev = anthropicChunkToEvents({ type: "content_block_delta", delta: { type: "text_delta", text: "x" } } as never, tools);
    expect(ev).toEqual([{ type: "text_delta", text: "x" }]);
    // No stop emitted until message_stop — a dropped tail is observable, not hidden.
  });

  it("gemini usage + finish map without tools", () => {
    const ev = geminiChunkToEvents(
      { candidates: [{ content: { parts: [{ text: "done" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2 } },
      new Map(),
    );
    expect(ev).toContainEqual({ type: "usage", input: 4, output: 2, cachedInput: undefined });
    expect(ev[ev.length - 1]).toEqual({ type: "stop", finishReason: "stop" });
  });

  it("parseSseStream decodes Uint8Array chunks (Node 22 live bodies)", async () => {    // Shared by the Anthropic, Gemini and Responses adapters: byte chunks
    // split mid-line must still parse (live-SSE fix).
    const enc = new TextEncoder();
    const frames = [
      `event: content_block_delta\ndata: {"delta":{"type":"text_delta","text":"he"}}\n\n`,
      `event: message_stop\ndata: {}\n\n`,
      "data: [DONE]\n\n",
    ];
    const body = (async function* (): AsyncGenerator<Uint8Array> {
      for (const f of frames) {
        const bytes = enc.encode(f);
        yield bytes.slice(0, 11);
        yield bytes.slice(11);
      }
    })();
    const out: Array<{ event: string; data: unknown }> = [];
    for await (const frame of parseSseStream(body)) out.push(frame);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ event: "content_block_delta", data: { delta: { type: "text_delta", text: "he" } } });
    expect(out[1]).toEqual({ event: "message_stop", data: {} });
  });

  it("anthropic folds history systems into the system param (none in messages)", async () => {
    let body: Record<string, unknown> = {};
    const fetchImpl = (async (_u: unknown, init: unknown) => {
      body = JSON.parse((init as { body?: string }).body ?? "{}") as Record<string, unknown>;
      return { ok: true, text: async () => "", body: (async function* () {})() };
    }) as unknown as typeof fetch;
    const provider = createAnthropicProvider({ model: "test-model", apiKey: "k", fetchImpl });
    // Drain (empty stream): only the request shape is under test.
    for await (const _ of provider.stream({
      system: "REQ",
      messages: [
        { role: "system", content: "<repository>ctx</repository>" },
        { role: "user", content: "hi" },
      ],
      tools: false,
    })) {
      // no events from an empty body
    }
    const systemText = typeof body.system === "string" ? body.system : JSON.stringify(body.system);
    expect(systemText).toContain("REQ");
    expect(systemText).toContain("<repository>ctx</repository>");
    for (const m of body.messages as Array<{ role: string }>) expect(m.role).not.toBe("system");
  });

  it("gemini folds history systems into system_instruction", async () => {
    let body: Record<string, unknown> = {};
    const fetchImpl = (async (_u: unknown, init: unknown) => {
      body = JSON.parse((init as { body?: string }).body ?? "{}") as Record<string, unknown>;
      return { ok: true, text: async () => "", body: (async function* () {})() };
    }) as unknown as typeof fetch;
    const provider = createGeminiProvider({ model: "test-model", apiKey: "k", fetchImpl });
    for await (const _ of provider.stream({
      system: "REQ",
      messages: [
        { role: "system", content: "<repository>ctx</repository>" },
        { role: "user", content: "hi" },
      ],
      tools: false,
    })) {
      // no events from an empty body
    }
    const instruction = (
      body.system_instruction as { parts: Array<{ text: string }> }
    ).parts.map((p) => p.text).join("\n");
    expect(instruction).toContain("REQ");
    expect(instruction).toContain("<repository>ctx</repository>");
  });
});
