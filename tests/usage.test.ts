import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Agent } from "../src/agent/agent.js";
import type { Responder } from "../src/llm/client.js";
import { normalizeUsage, genMsPerToken, appendTurnRecord } from "../eval/instrument.js";
import { collectProviderEvents } from "../src/llm/stream.js";

/** ML-9: prompt-cache hits reported by providers accumulate into run usage. */

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "agent-usage-"));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("usage accumulation", () => {
  it("accumulates cachedInput across model calls", async () => {
    let n = 0;
    const responder: Responder = async () => {
      n++;
      if (n === 1) {
        return { output: [], output_text: "done", usage: { input: 100, output: 20, cachedInput: 30 } };
      }
      return { output: [], output_text: "done" };
    };
    const agent = new Agent({ repoRoot: tmp, model: "test", maxIterations: 5, responder, verbose: false });
    const result = await agent.run("Summarize the repository layout");
    expect(result.usage?.input).toBeGreaterThanOrEqual(100);
    expect(result.usage?.cachedInput).toBe(30);
  });

  it("treats missing cachedInput as zero", async () => {
    const responder: Responder = async () => ({
      output: [],
      output_text: "done",
      usage: { input: 10, output: 5 },
    });
    // maxIterations: 1 isolates usage accounting from the no-action nudge
    // (which would otherwise add a second model call on text-only turns).
    const agent = new Agent({ repoRoot: tmp, model: "test", maxIterations: 1, responder, verbose: false });
    const result = await agent.run("Summarize the repository layout");
    expect(result.usage).toMatchObject({ input: 10, output: 5, cachedInput: 0 });
  });
});

describe("Phase 1 instrumentation", () => {
  it("sends stream_options include_usage on chat completions", async () => {
    let seenBody: Record<string, unknown> | null = null;
    const client = {
      chat: {
        completions: {
          create: async (body: Record<string, unknown>) => {
            seenBody = body;
            async function* chunks() {
              yield { choices: [{ delta: { content: "hi" } }] };
              yield { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2 } };
            }
            return chunks() as unknown as Awaited<ReturnType<import("../src/llm/chatProvider.js").MinimalChatClient["chat"]["completions"]["create"]>>;
          },
        },
      },
    };
    const { createChatResponder } = await import("../src/llm/chatProvider.js");
    const respond = createChatResponder(client as never, { model: "m", systemPrompt: "SYS" });
    await respond([{ role: "user", content: "hi" }]);
    expect(seenBody).toMatchObject({ stream_options: { include_usage: true } });
  });

  it("estimates usage when the provider sends none (never silent 0)", async () => {
    const result = await collectProviderEvents(
      (async function* () {
        yield { type: "text_delta", text: "hello world, this is a test response" } as const;
        yield { type: "stop", finishReason: "stop" } as const;
      })(),
    );
    expect(result.usage?.usageEstimated).toBe(true);
    expect(result.usage?.output).toBeGreaterThan(0);
    expect(result.usage?.reasoningTokens).toBeNull();
  });

  it("keeps reasoningTokens null when the provider omits them, with numeric genMsPerToken", () => {
    const u = normalizeUsage({ input_tokens: 10, output_tokens: 5 }, "hello");
    expect(u.reasoningTokens).toBeNull();
    expect(u.usageEstimated).toBe(false);
    expect(genMsPerToken(90, 9)).toBe(10);
    const est = normalizeUsage(null, "hello world");
    expect(est.usageEstimated).toBe(true);
    expect(est.output).toBeGreaterThan(0);
  });

  it("per-turn JSONL is UTF-8 with queueMs and providerRetries", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jsonl-"));
    try {
      appendTurnRecord(dir, "advanced-v2", "adv-test", 1, {
        taskId: "adv-test",
        seed: 1,
        turn: 1,
        queueMs: 12,
        ttftMs: 15,
        reasoningTokens: null,
        outputTokens: 8,
        inputTokens: 100,
        usageEstimated: true,
        generationMs: 80,
        genMsPerToken: 10,
        toolMs: 5,
        providerRetries: 0,
        turnMs: 100,
        failureClass: "pass",
      });
      const raw = await fs.readFile(path.join(dir, "eval", "results", "advanced-v2", "adv-test-seed1.jsonl"), "utf8");
      const rec = JSON.parse(raw.trim());
      expect(rec.queueMs).toBe(12);
      expect(rec.providerRetries).toBe(0);
      expect(rec.reasoningTokens).toBeNull();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
