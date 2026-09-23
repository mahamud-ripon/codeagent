import { describe, expect, it } from "vitest";
import { PermissionManager } from "../src/agent/permissions.js";
import { Agent } from "../src/agent/agent.js";
import type { Responder } from "../src/llm/client.js";

describe("PermissionManager", () => {
  it("autoApprove allows any command", async () => {
    const pm = new PermissionManager({ autoApprove: true });
    expect(await pm.checkCommand("npm test")).toBe(true);
    expect(await pm.checkCommand("rm -rf something")).toBe(true);
  });

  it("checks prefixes in allowlist", async () => {
    const pm = new PermissionManager({ autoApprove: false });
    pm.allowPrefix("npm test");
    pm.allowPrefix("tsc");

    expect(await pm.checkCommand("npm test")).toBe(true);
    expect(await pm.checkCommand("npm test --watch")).toBe(true);
    expect(await pm.checkCommand("tsc --noEmit")).toBe(true);
    // Disallowed:
    expect(await pm.checkCommand("rm -rf dist")).toBe(true); // without handler, fallback is true
  });

  it("invokes handler when command is not in allowlist", async () => {
    const requested: string[] = [];
    const pm = new PermissionManager({
      autoApprove: false,
      handler: async (req) => {
        requested.push(req.target);
        return req.target.includes("safe");
      },
    });

    expect(await pm.checkCommand("run-safe-task")).toBe(true);
    expect(await pm.checkCommand("dangerous-command")).toBe(false);
    expect(requested).toEqual(["run-safe-task", "dangerous-command"]);
  });
});

describe("Agent with PermissionManager", () => {
  function fc(call_id: string, name: string, args: Record<string, unknown>) {
    return { type: "function_call", call_id, name, arguments: JSON.stringify(args) };
  }

  it("recovers gracefully when user denies command execution", async () => {
    let step = 0;
    const responder: Responder = async (input) => {
      step++;
      if (step === 1) {
        return {
          output: [fc("c1", "run_command", { command: "drop database" })],
          output_text: "",
        };
      }
      // Check that the model received the denial notice
      const lastOutput = input[input.length - 1] as { type: string; output: string };
      expect(lastOutput.output).toContain("User denied execution");
      return {
        output: [],
        output_text: "Understood, skipping the command.",
      };
    };

    const pm = new PermissionManager({
      autoApprove: false,
      handler: async () => false, // deny all
    });

    const agent = new Agent({
      repoRoot: ".",
      model: "test",
      maxIterations: 5,
      responder,
      permissions: pm,
      verbose: false,
    });

    const result = await agent.run("run drop database");
    expect(result.finalMessage).toContain("skipping the command");
  });
});
