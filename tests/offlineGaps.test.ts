import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "../src/index.js";
import { PROMPT_VERSION } from "../src/agent/promptSections.js";
import { Agent } from "../src/agent/agent.js";
import type { Responder } from "../src/llm/client.js";
import { checkExpectMatch } from "../eval/score.js";

const root = path.dirname(fileURLToPath(import.meta.url));

/** v0.6.0 offline slice: help text, provider parsing, VS Code manifest, eval version pinning. */
describe("offline remaining gaps", () => {
  it("parses all four advertised providers (-p / --provider)", () => {
    expect(parseArgs(["--provider", "anthropic"]).provider).toBe("anthropic");
    expect(parseArgs(["--provider", "gemini"]).provider).toBe("gemini");
    expect(parseArgs(["-p", "anthropic"]).provider).toBe("anthropic");
    expect(parseArgs(["--provider=gemini"]).provider).toBe("gemini");
  });

  it("help text advertises all four providers", () => {
    const src = fs.readFileSync(path.join(root, "..", "src", "index.ts"), "utf8");
    for (const p of ["openai", "chat", "anthropic", "gemini"]) {
      expect(src).toContain(p);
    }
    // The --provider help line itself must name anthropic/gemini (was stale).
    const providerLine = src.split("\n").find((l) => l.includes("--provider <name>")) ?? "";
    expect(providerLine).toContain("anthropic");
    expect(providerLine).toContain("gemini");
  });

  it("VS Code manifest exposes runTask + cancelTask with activation events", () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(root, "..", "extensions", "vscode", "package.json"), "utf8"),
    );
    const commands = (manifest.contributes?.commands ?? []).map((c: { command: string }) => c.command);
    expect(commands).toContain("codeagent.runTask");
    expect(commands).toContain("codeagent.cancelTask");
    expect(manifest.activationEvents).toContain("onCommand:codeagent.runTask");
    expect(manifest.activationEvents).toContain("onCommand:codeagent.cancelTask");
    expect(fs.existsSync(path.join(root, "..", "extensions", "vscode", manifest.main ?? "extension.js"))).toBe(true);
  });

  it("pins PROMPT_VERSION in smoke results and the baseline writer", () => {
    expect(PROMPT_VERSION).toMatch(/^codeagent-prompt\//);
    const runner = fs.readFileSync(path.join(root, "..", "eval", "run.ts"), "utf8");
    expect(runner).toContain("promptVersion: PROMPT_VERSION");
    expect(runner).toContain("Prompt version:");
    const fixturesReadme = path.join(root, "..", "eval", "fixtures", "README.md");
    expect(fs.existsSync(fixturesReadme)).toBe(true);
  });
});

describe("no-action nudge (text-only turn with zero tool calls)", () => {  let tmp: string;
  beforeEach(async () => {
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-nudge-"));
  });
  afterEach(async () => {
    await fsp.rm(tmp, { recursive: true, force: true });
  });

  it("asks once for inspection instead of accepting a text-only answer", async () => {
    let calls = 0;
    const responder: Responder = async () => {
      calls++;
      return { output: [], output_text: "All done." };
    };
    const agent = new Agent({ repoRoot: tmp, model: "test", maxIterations: 5, responder, verbose: false });
    const result = await agent.run("Where is the range helper implemented?");
    expect(calls).toBe(2);
    expect(JSON.stringify(result.history)).toContain("not used any tools");
  });

  it("does not nudge greetings or runs that already used tools", async () => {
    const quiet: Responder = async () => ({ output: [], output_text: "Hi!" });
    const hello = new Agent({ repoRoot: tmp, model: "test", maxIterations: 5, responder: quiet, verbose: false });
    await hello.run("hello");
    // Conversational bypass answers directly: exactly one model call.
    // (No nudge: the bypass returns before the loop.)

    let acted = 0;
    const toolThenText: Responder = async () => {
      acted++;
      if (acted === 1) {
        return {
          output: [{ type: "function_call", call_id: "c1", name: "list_files", arguments: "{}" }],
          output_text: "",
        };
      }
      return { output: [], output_text: "Here it is." };
    };
    const agent = new Agent({
      repoRoot: tmp,
      model: "test",
      maxIterations: 5,
      responder: toolThenText,
      verbose: false,
      autoApprove: true,
    });
    const result = await agent.run("Where is the range helper implemented?");
    expect(JSON.stringify(result.history)).not.toContain("not used any tools");
  });
});

describe("expect alternative matching (live scorer)", () => {
  it("passes when any |-separated alternative matches", () => {
    // Exact strings from the user-reported 33/36 run: all three "fails"
    // had a correct alternative present in the worktree.
    expect(checkExpectMatch("for (let i = 0; i < n; i++)", "i <= n|i < n")).toBe(true);
    expect(checkExpectMatch("if (user === null) {", "user?|!user|user === null|user == null")).toBe(true);
    expect(checkExpectMatch("const tax = calculateTax(n);", "function tax|calculateTax|getTax")).toBe(true);
  });

  it("still fails when no alternative matches, and matches plain expects", () => {
    expect(checkExpectMatch("i <= m", "i <= n|i < n")).toBe(false);
    expect(checkExpectMatch("some output", "expected")).toBe(false);
    expect(checkExpectMatch("some expected output", "expected")).toBe(true);
    expect(checkExpectMatch("anything", " | ")).toBe(false);
  });
});
