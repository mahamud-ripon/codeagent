import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Agent } from "../src/agent/agent.js";
import { writeFile } from "../src/tools/filesystem.js";
import type { Responder } from "../src/llm/client.js";

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "agent-loop-"));
  await writeFile(tmp, "math.ts", "export function add(a: number, b: number) {\n  return a - b;\n}\n");
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

function fc(call_id: string, name: string, args: Record<string, unknown>) {
  return { type: "function_call", call_id, name, arguments: JSON.stringify(args) };
}

describe("agent loop", () => {
  it("executes tools and returns the final message, tracking modified files", async () => {
    const calls: string[] = [];
    const responder: Responder = async () => {
      const n = calls.length;
      calls.push(`turn-${n}`);
      if (n === 0) return { output: [fc("c1", "read_file", { path: "math.ts" })], output_text: "" };
      if (n === 1) {
        return {
          output: [fc("c2", "edit_file", {
            path: "math.ts",
            old_text: "return a - b;",
            new_text: "return a + b;",
          })],
          output_text: "",
        };
      }
      // n>=2 covers the post-edit final + the diff-review re-prompt.
      return { output: [], output_text: "## Summary\nFixed add().\n" };
    };

    const agent = new Agent({ repoRoot: tmp, model: "test", maxIterations: 10, responder, verbose: false });
    const result = await agent.run("Fix add()");
    expect(result.finalMessage).toContain("Fixed add()");
    expect(result.modifiedFiles).toContain("math.ts");
    const content = await fs.readFile(path.join(tmp, "math.ts"), "utf8");
    expect(content).toContain("return a + b;");
  });

  it("recovers from tool errors instead of crashing", async () => {
    let n = 0;
    const responder: Responder = async () => {
      n++;
      if (n === 1) return { output: [fc("c1", "read_file", { path: "does-not-exist.ts" })], output_text: "" };
      return { output: [], output_text: "## Summary\nFile missing, nothing to do.\n" };
    };
    const agent = new Agent({ repoRoot: tmp, model: "test", maxIterations: 5, responder, verbose: false });
    const result = await agent.run("Read a missing file");
    expect(result.finalMessage).toContain("nothing to do");
  });

  it("handles malformed JSON args gracefully", async () => {
    let n = 0;
    const responder: Responder = async () => {
      n++;
      if (n === 1) return { output: [{ type: "function_call", call_id: "c1", name: "read_file", arguments: "{bad json" }], output_text: "" };
      return { output: [], output_text: "done" };
    };
    const agent = new Agent({ repoRoot: tmp, model: "test", maxIterations: 5, responder, verbose: false });
    await expect(agent.run("x")).resolves.toMatchObject({ finalMessage: "done" });
  });

  it("aborts when the model repeats the identical call", async () => {
    const responder: Responder = async () => ({
      output: [fc("c1", "read_file", { path: "math.ts" })],
      output_text: "",
    });
    const agent = new Agent({ repoRoot: tmp, model: "test", maxIterations: 20, responder, verbose: false });
    await expect(agent.run("loop forever")).rejects.toThrow(/repeating|exceeded/i);
  });

  it("backs off on rate limits without polluting history", async () => {
    const inputLengths: number[] = [];
    const slept: number[] = [];
    let n = 0;
    const responder: Responder = async (input) => {
      inputLengths.push(input.length);
      n++;
      if (n <= 2) throw new Error("413 Request too large (ITPM): Limit 7000, Requested 10760");
      return { output: [], output_text: "recovered" };
    };
    const agent = new Agent({
      repoRoot: tmp,
      model: "test",
      maxIterations: 8,
      responder,
      verbose: false,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    const result = await agent.run("x");
    expect(result.finalMessage).toBe("recovered");
    expect(slept).toEqual([10_000, 20_000]);
    // Retried request is identical — no error messages appended.
    expect(inputLengths[1]).toBe(inputLengths[0]);
    expect(inputLengths[2]).toBe(inputLengths[0]);
  });

  it("gives up on persistent rate limits with a helpful error", async () => {
    const responder: Responder = async () => {
      throw new Error("429 rate limit exceeded");
    };
    const agent = new Agent({
      repoRoot: tmp,
      model: "test",
      maxIterations: 30,
      responder,
      verbose: false,
      sleep: async () => {},
    });
    await expect(agent.run("x")).rejects.toThrow(/rate limit persisted|roomier model/i);
  });

  it("fails fast on 401 with a fix hint (no retries)", async () => {
    let calls = 0;
    const responder: Responder = async () => {
      calls++;
      throw new Error("401 Incorrect API key provided");
    };
    const agent = new Agent({
      repoRoot: tmp,
      model: "test",
      maxIterations: 10,
      responder,
      verbose: false,
      sleep: async () => {},
    });
    await expect(agent.run("x")).rejects.toThrow(/authentication failed[\s\S]*\/endpoint/i);
    expect(calls).toBe(1);
  });

  it("respects AbortSignal cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    const responder: Responder = async () => ({ output: [], output_text: "never" });
    const agent = new Agent({ repoRoot: tmp, model: "test", maxIterations: 5, responder, verbose: false });
    await expect(agent.run("x", { signal: controller.signal })).rejects.toThrow(/cancelled/i);
  });

  it("handles conversational inputs directly without tool execution", async () => {
    let calls = 0;
    const responder: Responder = async (input) => {
      calls++;
      // Verify no heavy repo context or task XML was injected for conversational
      const userMessage = input[input.length - 1] as { role: string; content: string };
      expect(userMessage.content).toBe("can you help me?");
      return { output: [], output_text: "Sure! What would you like to work on?" };
    };

    const agent = new Agent({ repoRoot: tmp, model: "test", maxIterations: 10, responder, verbose: false });
    const result = await agent.run("can you help me?");

    expect(calls).toBe(1);
    expect(result.iterations).toBe(1);
    expect(result.intent).toBe("conversational");
    expect(result.modifiedFiles).toEqual([]);
    expect(result.testResults).toEqual([]);
    expect(result.finalMessage).toContain("What would you like to work on?");
    expect(result.history).toBeDefined();
  });

  it("preserves conversation history across multi-turn interactions", async () => {
    let turn = 0;
    const responder: Responder = async (input) => {
      turn++;
      if (turn === 1) {
        return { output: [], output_text: "Hello! Ready to help." };
      }
      if (turn === 2) {
        // Second turn first call should contain the first turn's history
        expect(input.length).toBeGreaterThan(2);
        return {
          output: [fc("c1", "edit_file", { path: "math.ts", old_text: "return a - b;", new_text: "return a + b;" })],
          output_text: "",
        };
      }
      // Finish turn 2
      return { output: [], output_text: "Fixed." };
    };

    const agent = new Agent({ repoRoot: tmp, model: "test", maxIterations: 10, responder, verbose: false });
    const firstResult = await agent.run("hello");
    expect(firstResult.intent).toBe("conversational");

    const secondResult = await agent.run("fix add in math.ts", { history: firstResult.history });
    expect(secondResult.intent).toBe("task");
    expect(secondResult.modifiedFiles).toContain("math.ts");
  });

  it("does not wrap user requests in raw <task> XML tags and injects repo context cleanly", async () => {
    let capturedInput: unknown[] = [];
    const responder: Responder = async (input) => {
      capturedInput = [...input];
      return { output: [], output_text: "done" };
    };

    const agent = new Agent({ repoRoot: tmp, model: "test", maxIterations: 5, responder, verbose: false });
    await agent.run("explain how math.ts works");

    const userMessage = capturedInput.find(
      (item) => (item as { role?: string }).role === "user",
    ) as { content: string };
    const systemRepoMessage = capturedInput.find(
      (item) => (item as { role?: string }).role === "system",
    ) as { content: string };

    expect(userMessage.content).not.toContain("<task>");
    expect(userMessage.content).not.toContain("</task>");
    expect(userMessage.content).toBe("explain how math.ts works");
    expect(systemRepoMessage.content).toContain("<repository>");
  });

  it("passes model thinking / reasoning to reporter.onThinking", async () => {
    let capturedThinking = "";
    const mockReporter = {
      onIterationStart: () => {},
      onThinking: (thinking: string) => {
        capturedThinking = thinking;
      },
      onToolStart: () => {},
      onToolComplete: () => {},
      onProgressMessage: () => {},
      onError: () => {},
      stop: () => {},
    };

    const responder: Responder = async () => {
      return {
        output: [],
        output_text: "Done with explanation",
        reasoning_text: "Thinking about the architecture of math.ts",
      };
    };

    const agent = new Agent({
      repoRoot: tmp,
      model: "test",
      maxIterations: 5,
      responder,
      reporter: mockReporter,
      verbose: false,
    });

    await agent.run("explain math.ts");
    expect(capturedThinking).toBe("Thinking about the architecture of math.ts");
  });

  it("executes consecutive read-only tools in parallel", async () => {
    await writeFile(tmp, "util.ts", "export const PI = 3.14;\n");
    let turn = 0;
    const responder: Responder = async () => {
      turn++;
      if (turn === 1) {
        return {
          output: [
            fc("c1", "read_file", { path: "math.ts" }),
            fc("c2", "read_file", { path: "util.ts" }),
          ],
          output_text: "",
        };
      }
      return {
        output: [],
        output_text: "Read both files successfully.",
      };
    };

    const agent = new Agent({
      repoRoot: tmp,
      model: "test",
      maxIterations: 5,
      responder,
      verbose: false,
    });

    const res = await agent.run("Read math.ts and util.ts");
    expect(res.finalMessage).toBe("Read both files successfully.");
    expect(res.history.some((item) => (item as { call_id?: string }).call_id === "c1")).toBe(true);
    expect(res.history.some((item) => (item as { call_id?: string }).call_id === "c2")).toBe(true);
  });
});


