import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentRuntime } from "../src/runtime/runtime.js";
import { RuntimeTextOutput } from "../src/runtime/cli.js";
import { compactMessages } from "../src/runtime/context.js";
import { fromProvider, type Message, type RuntimeEvent } from "../src/runtime/contracts.js";
import { CONSERVATIVE_CAPABILITIES } from "../src/llm/capabilities.js";
import { systemPromptForModel } from "../src/llm/provider.js";
import { classifyIntent } from "../src/agent/intent.js";
import { startSupervisor } from "../src/runtime/supervisor.js";
import { RuntimeClient } from "../src/runtime/client.js";
import { JournalStore } from "../src/runtime/store.js";

const dirs: string[] = [];
async function temp() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codeagent-conversation-"));
  dirs.push(root);
  return root;
}
afterEach(async () => {
  for (const root of dirs.splice(0)) await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
});
const event = (type: string, data: Record<string, unknown> = {}, agentId = "coordinator") =>
  ({ type, data, agentId } as RuntimeEvent);

describe("conversation rendering", () => {
  it("prints streamed answers once and preserves completion warnings", () => {
    const output = new RuntimeTextOutput();
    const rendered = [
      event("model_start"), event("text_delta", { text: "Hello " }),
      event("text_delta", { text: "world." }),
      event("done", { finalMessage: "Hello world.\nIncomplete: checks pending", status: "blocked" }),
    ].map((e) => output.render(e)).join("");
    expect(rendered).toBe("Hello world.\nIncomplete: checks pending\nStatus: blocked\n");
  });
  it("keeps the final response after a streamed intermediate turn or failure", () => {
    const output = new RuntimeTextOutput();
    const rendered = [
      event("model_start"), event("text_delta", { text: "Inspecting." }),
      event("model_start"), event("text_delta", { text: "worker text" }, "worker-1"),
      event("done", { finalMessage: "Done without streaming.", status: "completed" }),
    ].map((e) => output.render(e)).join("");
    expect(rendered).toBe("Inspecting.\nDone without streaming.\nStatus: completed\n");
    const failed = new RuntimeTextOutput();
    failed.render(event("text_delta", { text: "Partial" }));
    expect(failed.render(event("done", { finalMessage: "Run failed: offline", status: "failed" })))
      .toContain("Run failed: offline");
  });
  it("does not let compaction or child model calls reset coordinator output", () => {
    const output = new RuntimeTextOutput();
    output.render(event("text_delta", { text: "Answer" }));
    output.render(event("model_start", {}, "child"));
    output.render(event("model_start", { role: "compaction" }));
    expect(output.render(event("done", { finalMessage: "Answer", status: "completed" })))
      .toBe("\nStatus: completed\n");
  });
});

describe("conversation sessions", () => {
  it.each(["samarize our coversation", "samarize our conversation", "summarise our chat"])(
    "routes %s without repository tools", (prompt) => expect(classifyIntent(prompt)).toBe("conversational"),
  );
  it("still routes file actions about conversation features as tasks", () => {
    expect(classifyIntent("add a summary of our conversation to chat.ts")).toBe("task");
  });
  it("runs the reported dialogue through IPC, preserving identity, history and replay", async () => {
    const home = await temp(), root = await temp();
    let calls = 0;
    const service = await startSupervisor(home, {
      responder: async () => { throw new Error("Expected streaming provider"); },
      systemPrompt: systemPromptForModel("unknown-model"),
      providerInstance: {
        capabilities: CONSERVATIVE_CAPABILITIES,
        async *stream(req) {
          calls++;
          expect(req.tools).toBe(false);
          const messages = fromProvider(req.messages);
          const instructions = messages.filter((m) => m.kind === "text" && m.role === "system");
          expect(instructions).toHaveLength(1);
          expect(JSON.stringify(instructions)).toContain("Mahamud Ripon");
          expect(JSON.stringify(instructions)).toContain("underlying language model");
          expect(JSON.stringify(instructions)).not.toContain("Current repository context");
          if (calls > 1) expect(JSON.stringify(messages)).toContain(`Answer ${calls - 1}:`);
          const answer = `Answer ${calls}: ${"A detailed explanation. ".repeat(40)}`;
          yield { type: "text_delta" as const, text: answer.slice(0, 40) };
          yield { type: "text_delta" as const, text: answer.slice(40) };
          yield { type: "stop" as const, finishReason: "stop" };
        },
      },
    });
    try {
      let client = new RuntimeClient(home);
      const session = await client.create(root, { model: "unknown-model" });
      for (const prompt of ["hello", "what is codeagent?", "who made you?", "what is anthropic?",
        "samarize our coversation", "samarize our conversation", "hello?"]) {
        const handle = await client.submit(session.id, prompt);
        const output = new RuntimeTextOutput();
        let rendered = "";
        for await (const e of handle.events()) rendered += output.render(e);
        const result = await handle.result();
        expect(result.status).toBe("completed");
        expect(rendered.split(result.finalMessage)).toHaveLength(2);
        const answers = fromProvider(result.history ?? []).filter((m) => m.kind === "text" && m.role === "assistant");
        expect(answers).toHaveLength(calls + 1);
        client = new RuntimeClient(home); // New client connection each turn.
      }
      const reattached = await client.attach(session.id);
      const output = new RuntimeTextOutput();
      let replay = "";
      for await (const e of reattached.events()) replay += output.render(e);
      expect(replay.split((await reattached.result()).finalMessage)).toHaveLength(2);
    } finally { await service.close(); }
  }, 30_000);

  it("recovers conversational turns with oversized repository context in old history", async () => {
    const root = await temp();
    let called = false;
    const runtime = new AgentRuntime({
      repoRoot: root, model: "unknown-model", maxIterations: 3,
      responder: async (history) => {
        called = true;
        expect(JSON.stringify(history)).not.toContain("Current repository context");
        expect(JSON.stringify(history)).toContain("Keep the public API");
        return { output: [{ type: "message", content: "Recovered" }], output_text: "Recovered" };
      },
    });
    const result = await runtime.run("samarize our conversation", { history: [
      { role: "system", content: `Current repository context:\n${"file ".repeat(20000)}` },
      { role: "user", content: "Keep the public API" },
      { role: "assistant", content: "Understood" },
    ] });
    expect(called).toBe(true);
    expect(result.status).toBe("completed");
    expect(fromProvider(result.history ?? []).filter((m) => m.kind === "text" && m.text === "Recovered"))
      .toHaveLength(1);
  });

  it.each([
    [{ type: "message", content: "Answer" }],
    [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Answer" }] }],
    [{ role: "assistant", content: "Answer" }],
    [],
  ].map((output) => ({ output })))("stores one answer for provider output $output", async ({ output }) => {
    const runtime = new AgentRuntime({
      repoRoot: await temp(), model: "unknown", maxIterations: 1,
      responder: async () => ({ output, output_text: "Answer" }),
    });
    const result = await runtime.run("what is codeagent?");
    expect(fromProvider(result.history ?? []).filter((m) => m.kind === "text" && m.role === "assistant"))
      .toEqual([{ kind: "text", role: "assistant", text: "Answer" }]);
  });
});

describe("context capacity", () => {
  const opts = { window: 2000, outputReserve: 500, pinned: "Task pending; preserve API", sessionId: "s" };
  const estimate = (messages: Message[]) => Math.ceil(JSON.stringify(messages).length / 3);
  it("compacts fewer than twelve large messages, repeatedly retaining constraints", async () => {
    const instructions: Message[] = [
      { kind: "text", role: "system", text: "Preserve the database schema" },
      { kind: "text", role: "user", text: "Do not change authentication" },
    ];
    let history = instructions;
    for (let i = 0; i < 4; i++) {
      history = await compactMessages([...history,
        { kind: "text", role: "assistant", text: "A lengthy explanation. ".repeat(400) },
        { kind: "text", role: "user", text: `Summarize discussion ${i}` },
      ], opts);
      expect(estimate(history)).toBeLessThan(1500);
      for (const m of instructions) expect(history).toContainEqual(m);
      expect(JSON.stringify(history)).toContain("Task pending; preserve API");
      expect(history.filter((m) => m.kind === "text" && m.text.startsWith("Session continuity:")))
        .toHaveLength(1);
    }
  });
  it("bounds verbose summaries and keeps tool-call batches with their results", async () => {
    const history: Message[] = [
      { kind: "text", role: "user", text: "Implement feature" },
      { kind: "call", id: "a", name: "read", arguments: "{}" },
      { kind: "call", id: "b", name: "read", arguments: "{}" },
      { kind: "result", id: "a", text: "a".repeat(5000) },
      { kind: "result", id: "b", text: "b".repeat(5000) },
      { kind: "text", role: "assistant", text: "Plan ready" },
      { kind: "call", id: "live", name: "read", arguments: "{}" },
    ];
    const out = await compactMessages(history, { ...opts,
      summarizer: async () => ({ output: [], output_text: "Long summary ".repeat(5000) }),
    });
    expect(estimate(out)).toBeLessThan(1500);
    expect(out).toContainEqual(history.at(-1));
    for (const id of ["a", "b"]) {
      expect(out.some((m) => m.kind === "call" && m.id === id))
        .toBe(out.some((m) => m.kind === "result" && m.id === id));
    }
  });
  it("externalizes large recent results to retrievable artifacts", async () => {
    const store = new JournalStore(await temp());
    const out = await compactMessages([
      { kind: "call", id: "a", name: "read", arguments: "{}" },
      { kind: "result", id: "a", text: "tool result ".repeat(2000) },
    ], { ...opts, store });
    expect(estimate(out)).toBeLessThan(1500);
    expect(out[0].kind).toBe("call");
    expect(JSON.stringify(out)).toContain("Full output: artifact");
  });
  it("rejects truly oversized pinned instructions", async () => {
    await expect(compactMessages([{ kind: "text", role: "system", text: "rule ".repeat(3000) }], opts))
      .rejects.toThrow("Pinned context exceeds");
  });
});
