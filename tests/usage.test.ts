import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Agent } from "../src/agent/agent.js";
import type { Responder } from "../src/llm/client.js";

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
