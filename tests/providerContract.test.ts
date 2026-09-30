import { describe, expect, it } from "vitest";
import { chatChunkToEvents } from "../src/llm/stream.js";
import { anthropicChunkToEvents } from "../src/llm/anthropic.js";
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
});
