import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { classifyIntent } from "../src/agent/intent.js";
import { AgentRuntime } from "../src/runtime/runtime.js";
import { runtimeCli } from "../src/runtime/cli.js";
import { RuntimeClient } from "../src/runtime/client.js";
import { startSupervisor } from "../src/runtime/supervisor.js";
import type { CliArgs } from "../src/index.js";
const roots: string[] = [];
async function temp() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codeagent-followup-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
  await fs.rm(path.join(os.homedir(), ".claude"), { recursive: true, force: true, maxRetries: 5 });
});
describe("follow-up intent", () => {
  it.each(["i want all topic", "all of them", "more detail", "continue", "go on"])(
    "keeps ambiguous %s in its previous mode", (prompt) => {
      expect(classifyIntent(prompt, "conversational")).toBe("conversational");
      expect(classifyIntent(prompt, "task")).toBe("task");
      expect(classifyIntent(prompt, "inquiry")).toBe("inquiry");
    },
  );
  it("lets explicit new requests override the previous mode", () => {
    expect(classifyIntent("fix math.ts", "conversational")).toBe("task");
    expect(classifyIntent("inspect the repository", "conversational")).toBe("inquiry");
    expect(classifyIntent("where is authentication implemented?", "conversational")).toBe("inquiry");
    expect(classifyIntent("search the web for today's news", "conversational")).toBe("external");
    expect(classifyIntent("summarize our conversation", "task")).toBe("conversational");
  });
  it("continues the reported conversation across runtime instances without loading global rules", async () => {
    const root = await temp();
    const directory = path.join(os.homedir(), ".claude", "rules", "common");
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "large.md"), "Do not change public APIs.\n".repeat(950));
    let history: unknown[] = [
      { role: "user", content: "who made you?" },
      { role: "assistant", content: "My name is Nemotron, created by NVIDIA researchers." },
      { role: "user", content: "summarize our conversation" },
      { role: "assistant", content: "We discussed CodeAgent and Anthropic." },
      { role: "user", content: "i want all topic" },
      { role: "system", content: "Project instruction:\nSource: old-rule.md\n" + "old rule ".repeat(3000) },
    ];
    for (const prompt of ["i want all topic", "all of them", "more detail", "continue", "hello?"]) {
      let calls = 0;
      const runtime = new AgentRuntime({ repoRoot: root, model: "unknown-model", maxIterations: 2,
        responder: async (input, options) => {
          calls++;
          expect(options?.tools).toBe(false);
          const text = JSON.stringify(input);
          expect(text).not.toContain("Do not change public APIs");
          expect(text).not.toContain("old-rule.md");
          expect(text).toContain("Mahamud Ripon");
          expect(text).toContain("Answer the latest user request");
          expect(text).toContain("Prior assistant messages can be mistaken");
          return { output: [], output_text: "All conversation topics." };
        },
      });
      const result = await runtime.run(prompt, { history });
      expect(result.status).toBe("completed");
      expect(result.intent).toBe("conversational");
      expect(calls).toBe(1);
      history = result.history;
    }
  });
  it("preserves coding follow-ups after a repository request", async () => {
    const runtime = new AgentRuntime({ repoRoot: await temp(), model: "test", maxIterations: 1,
      responder: async (_, options) => {
        expect(options?.tools).toBe(true);
        return { output: [], output_text: "Inspected" };
      },
    });
    const result = await runtime.run("continue", { history: [
      { role: "user", content: "Inspect the repository" },
      { role: "assistant", content: "I'll inspect the relevant files." },
    ] });
    expect(result.intent).toBe("inquiry");
    expect(result.status).toBe("completed");
  });
});

it("handles /sessions and unknown commands locally without submitting model work", async () => {
  const home = await temp(), root = await temp();
  let calls = 0;
  const service = await startSupervisor(home, { responder: async () => {
    calls++;
    return { output: [], output_text: "Unexpected model work" };
  } });
  const originalHome = process.env.CODEAGENT_RUNTIME_HOME;
  const tty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  try {
    process.env.CODEAGENT_RUNTIME_HOME = home;
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
    const client = new RuntimeClient(home);
    const session = await client.create(root, { model: "test" });
    const commands = ["/sessions", "/misspelled", "/help", "/exit"];
    vi.spyOn(readline, "createInterface").mockReturnValue({
      question: async () => commands.shift() ?? "/exit", close: () => {},
    } as unknown as ReturnType<typeof readline.createInterface>);
    const output: string[] = [];
    vi.spyOn(console, "log").mockImplementation((text) => { output.push(String(text)); });
    await runtimeCli({ repo: root, task: "" } as CliArgs, []);
    expect(output.join("\n")).toContain(session.id);
    expect(output.join("\n")).toContain("Unknown command: /misspelled");
    expect(output.join("\n")).toContain("Commands:");
    expect(calls).toBe(0);
    expect(await client.request("list")).toHaveLength(1);
    expect(service.supervisor.store.events(session.id)).toHaveLength(0);
  } finally {
    if (originalHome === undefined) delete process.env.CODEAGENT_RUNTIME_HOME;
    else process.env.CODEAGENT_RUNTIME_HOME = originalHome;
    if (tty) Object.defineProperty(process.stdin, "isTTY", tty);
    else Reflect.deleteProperty(process.stdin, "isTTY");
    await service.close();
  }
}, 15_000);
