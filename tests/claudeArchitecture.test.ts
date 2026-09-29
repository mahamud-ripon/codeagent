import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { interpretCommandResult } from "../src/tools/semantics.js";
import { DevLocalCommandRunner } from "../src/tools/runner.js";
import {
  OLD_TOOL_RESULT_CLEARED,
  microCompactToolResults,
  compactHistory,
} from "../src/agent/compactor.js";
import { runSubagent } from "../src/agent/subagent.js";
import { Agent } from "../src/agent/agent.js";
import type { Responder } from "../src/llm/client.js";

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "agent-claude-test-"));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("Claude Code Architecture & Logic Engineering", () => {
  describe("Command Semantics (Exit Code Handling)", () => {
    it("interprets grep and ripgrep exit code 1 as non-fatal no matches", () => {
      const grepResult = interpretCommandResult("grep foo file.txt", 1, "", "");
      expect(grepResult.isError).toBe(false);
      expect(grepResult.semanticMessage).toBe("No matches found");
      expect(grepResult.annotatedOutput).toBe("(no matches found)");

      const rgResult = interpretCommandResult("rg --no-heading query", 1, "", "");
      expect(rgResult.isError).toBe(false);
      expect(rgResult.semanticMessage).toBe("No matches found");
    });

    it("interprets diff exit code 1 as differences found rather than fatal crash", () => {
      const diffResult = interpretCommandResult("diff file1.ts file2.ts", 1, "--- +++", "");
      expect(diffResult.isError).toBe(false);
      expect(diffResult.semanticMessage).toBe("Differences found");
    });

    it("treats exit code 0 as success and unhandled non-zero as error", () => {
      const ok = interpretCommandResult("git status", 0, "clean", "");
      expect(ok.isError).toBe(false);

      const err = interpretCommandResult("npm test", 2, "", "failed");
      expect(err.isError).toBe(true);
      expect(err.semanticMessage).toContain("exited with code 2");
    });

    it("applies command semantics inside DevLocalCommandRunner", async () => {
      const runner = new DevLocalCommandRunner();
      // Test running a node script that exits with 0
      const res = await runner.run(tmp, 'node -e "console.log(\'hello\')"');
      expect(res.exitCode).toBe(0);
      expect(res.isError).toBe(false);
    });
  });

  describe("Micro-Compaction (Old Tool Result Clearing)", () => {
    it("clears older tool results using Claude Code standard marker", () => {
      expect(OLD_TOOL_RESULT_CLEARED).toBe("[Old tool result content cleared]");

      const history = [
        { role: "user", content: "Inspect codebase" },
        { type: "function_call", call_id: "c1", name: "list_files", arguments: "{}" },
        { type: "function_call_output", call_id: "c1", output: "huge directory tree ".repeat(50) },
        { type: "function_call", call_id: "c2", name: "read_file", arguments: '{"path":"a.ts"}' },
        { type: "function_call_output", call_id: "c2", output: "file a content ".repeat(50) },
        { type: "function_call", call_id: "c3", name: "read_file", arguments: '{"path":"b.ts"}' },
        { type: "function_call_output", call_id: "c3", output: "file b content" },
      ];

      // Keep only 1 recent output intact
      const compacted = microCompactToolResults(history, { keepRecent: 1 });
      expect(compacted).toHaveLength(7);

      const c1 = compacted.find(
        (m) =>
          (m as { type?: string }).type === "function_call_output" &&
          (m as { call_id?: string }).call_id === "c1",
      ) as { output: string };
      const c2 = compacted.find(
        (m) =>
          (m as { type?: string }).type === "function_call_output" &&
          (m as { call_id?: string }).call_id === "c2",
      ) as { output: string };
      const c3 = compacted.find(
        (m) =>
          (m as { type?: string }).type === "function_call_output" &&
          (m as { call_id?: string }).call_id === "c3",
      ) as { output: string };

      expect(c1.output).toBe(OLD_TOOL_RESULT_CLEARED);
      expect(c2.output).toBe(OLD_TOOL_RESULT_CLEARED);
      expect(c3.output).toBe("file b content");
    });

    it("supports useClearedMarker in compactHistory", () => {
      const history = [
        { role: "user", content: "Test" },
        { type: "function_call", call_id: "c1", name: "read_file", arguments: '{"path":"x.ts"}' },
        { type: "function_call_output", call_id: "c1", output: "X".repeat(1000) },
        { type: "function_call", call_id: "c2", name: "read_file", arguments: '{"path":"y.ts"}' },
        { type: "function_call_output", call_id: "c2", output: "Y".repeat(1000) },
      ];

      const compacted = compactHistory(history, { keepRecentToolOutputs: 1, useClearedMarker: true });
      const c1 = compacted.find(
        (m) =>
          (m as { type?: string }).type === "function_call_output" &&
          (m as { call_id?: string }).call_id === "c1",
      ) as { output: string };
      expect(c1.output).toBe(OLD_TOOL_RESULT_CLEARED);
    });
  });

  describe("Mid-Thought Output Token Recovery", () => {
    it("automatically prompts model to resume mid-thought when finish_reason is length", async () => {
      let turn = 0;
      const promptsReceived: string[] = [];

      const responder: Responder = async (input) => {
        turn++;
        const lastMsg = input[input.length - 1] as { role?: string; content?: string };
        if (typeof lastMsg?.content === "string") {
          promptsReceived.push(lastMsg.content);
        }

        if (turn === 1) {
          // Model response cuts off mid-thought due to length
          return {
            output: [{ type: "message", content: "Here is the first half of the code: function compute() {" }],
            output_text: "Here is the first half of the code: function compute() {",
            finish_reason: "length",
          };
        }

        // Second turn picks up and finishes
        return {
          output: [{ type: "message", content: " return 42; }" }],
          output_text: " return 42; }",
          finish_reason: "stop",
        };
      };

      const agent = new Agent({
        repoRoot: tmp,
        model: "test",
        maxIterations: 5,
        responder,
        verbose: false,
      });

      const result = await agent.run("Write compute function");
      expect(turn).toBe(2);
      expect(result.finalMessage).toContain("return 42;");
      expect(promptsReceived.some((p) => p.includes("Output token limit hit. Resume directly"))).toBe(true);
    });
  });

  describe("Subagent Personas (Explore & Plan)", () => {
    it("runs a Plan subagent and produces architecture & step-by-step implementation strategy", async () => {
      await fs.writeFile(path.join(tmp, "server.ts"), "export function createServer() {}\n", "utf8");

      let receivedPrompt = "";
      const responder: Responder = async (input) => {
        const sysMsg = input.find((m) => (m as { role?: string }).role === "system") as { content: string };
        receivedPrompt = sysMsg.content;

        return {
          output: [
            {
              type: "message",
              content:
                "### Architecture & Approach\nUse modular controllers.\n\n### Step-by-Step Implementation Plan\n1. Modify server.ts\n\n### Critical Files for Implementation\n- server.ts",
            },
          ],
          output_text:
            "### Architecture & Approach\nUse modular controllers.\n\n### Step-by-Step Implementation Plan\n1. Modify server.ts\n\n### Critical Files for Implementation\n- server.ts",
        };
      };

      const result = await runSubagent(tmp, "Plan server enhancements", {
        responder,
        subagentType: "plan",
      });

      expect(receivedPrompt).toContain("Software Architect and Planning Subagent");
      expect(result).toContain("### Architecture & Approach");
      expect(result).toContain("### Critical Files for Implementation");
      expect(result).toContain("server.ts");
    });
  });
});
