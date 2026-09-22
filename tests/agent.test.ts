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
});
