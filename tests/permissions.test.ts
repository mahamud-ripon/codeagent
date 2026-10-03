import { describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PermissionManager } from "../src/agent/permissions.js";
import { Agent } from "../src/agent/agent.js";
import type { Responder } from "../src/llm/client.js";

describe("PermissionManager", () => {
  it("autoApprove allows any command", async () => {
    const pm = new PermissionManager({ autoApprove: true });
    expect(pm.isAutoApprove()).toBe(true);
    expect(await pm.checkCommand("npm test")).toBe(true);
    expect(await pm.checkCommand("rm -rf something")).toBe(true);
  });

  it("can toggle autoApprove dynamically", async () => {
    const pm = new PermissionManager({ autoApprove: false, handler: async () => false });
    expect(pm.isAutoApprove()).toBe(false);
    expect(await pm.checkCommand("npm test")).toBe(false);

    pm.setAutoApprove(true);
    expect(pm.isAutoApprove()).toBe(true);
    expect(await pm.checkCommand("npm test")).toBe(true);
  });

  it("checks prefixes in allowlist", async () => {
    const pm = new PermissionManager({ autoApprove: false });
    pm.allowPrefix("npm test");
    pm.allowPrefix("tsc");

    expect(await pm.checkCommand("npm test")).toBe(true);
    expect(await pm.checkCommand("npm test --watch")).toBe(true);
    expect(await pm.checkCommand("tsc --noEmit")).toBe(true);
    expect(await pm.checkCommand("rm -rf dist")).toBe(false);
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

    const deny = vi.fn(async () => false);
    const runCommand = vi.fn(async () => {
      throw new Error("A denied command must never reach the runner");
    });
    const pm = new PermissionManager({
      autoApprove: false,
      handler: deny,
    });

    // Exercise the real loop without scanning/hashing the developer's checkout.
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codeagent-denial-"));
    try {
      const agent = new Agent({
        repoRoot,
        model: "test",
        maxIterations: 5,
        responder,
        permissions: pm,
        commandRunner: { run: runCommand },
        verbose: false,
      });

      const result = await agent.run("run drop database");
      expect(result.finalMessage).toContain("skipping the command");
      expect(result.status).toBe("completed");
      expect(step).toBe(2);
      expect(deny).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        type: "command", target: "drop database",
      }));
      expect(runCommand).not.toHaveBeenCalled();
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
    // The loop still launches real Git probes; allow for busy Windows runners.
  }, 30_000);
});
