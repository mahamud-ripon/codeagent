import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runSubagent } from "../src/agent/subagent.js";
import type { Responder } from "../src/llm/client.js";

describe("runSubagent", () => {
  it("runs exploration loop and returns findings summary", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "agent-sub-"));
    try {
      await fs.writeFile(path.join(tmp, "auth.ts"), "export function verifyToken() { return true; }\n", "utf8");

      let turn = 0;
      const fakeResponder: Responder = async (input) => {
        turn++;
        if (turn === 1) {
          return {
            output: [
              {
                type: "function_call",
                call_id: "c1",
                name: "read_file",
                arguments: JSON.stringify({ path: "auth.ts" }),
              },
            ],
          };
        }
        return {
          output: [{ type: "message", content: "Auth is implemented in auth.ts with verifyToken." }],
          output_text: "Auth is implemented in auth.ts with verifyToken.",
        };
      };

      const result = await runSubagent(tmp, "How does auth work?", { responder: fakeResponder });
      expect(result).toContain("Auth is implemented in auth.ts with verifyToken.");
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("blocks modifying tools and returns permission error", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "agent-sub-"));
    try {
      let turn = 0;
      let recordedError = "";
      const fakeResponder: Responder = async (input) => {
        turn++;
        if (turn === 1) {
          return {
            output: [
              {
                type: "function_call",
                call_id: "c1",
                name: "write_file",
                arguments: JSON.stringify({ path: "test.txt", content: "hacked" }),
              },
            ],
          };
        }
        // Second turn inspects history to see tool error
        const lastOutput = input[input.length - 1] as { output?: string };
        recordedError = lastOutput.output ?? "";
        return {
          output: [{ type: "message", content: "Write was blocked." }],
          output_text: "Write was blocked.",
        };
      };

      const result = await runSubagent(tmp, "Try to write a file", { responder: fakeResponder });
      expect(result).toContain("Write was blocked.");
      expect(recordedError).toContain("read-only permissions");
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
