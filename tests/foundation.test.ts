import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PermissionManager, splitShellSegments } from "../src/agent/permissions.js";
import { shouldCompactHistory } from "../src/agent/compactor.js";
import { loadProjectMemory } from "../src/agent/rules.js";
import { exitCodeForStopReason } from "../src/cli/headless.js";
import { getModelCapabilities } from "../src/llm/capabilities.js";
import { mapResponsesApiResult } from "../src/llm/responsesMap.js";
import { collectProviderEvents, providerToResponder, scriptedProvider } from "../src/llm/stream.js";
import { responsesHistoryToChatMessages } from "../src/llm/chatProvider.js";
import { executeTool } from "../src/tools/index.js";
import { editFile, multiEdit, writeFile } from "../src/tools/filesystem.js";
import { FileStateCache } from "../src/tools/fileStateCache.js";
import { runSubagent } from "../src/agent/subagent.js";
import { measureStreamRender, renderDiffCard } from "../src/tui/spike.js";
import type { Responder } from "../src/llm/client.js";

describe("Responses adapter", () => {
  it("keeps message text, reasoning, and a length finish reason", () => {
    const mapped = mapResponsesApiResult({
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      output_text: "",
      output: [
        { type: "reasoning", id: "rs_1", content: [{ type: "reasoning_text", text: "thinking hard" }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "partial answer" }] },
      ],
      usage: { input_tokens: 10, output_tokens: 4 },
    });
    expect(mapped.reasoning_text).toContain("thinking hard");
    expect(mapped.finish_reason).toBe("length");
    expect(mapped.output.find((item) => item.type === "message")?.content).toBe("partial answer");
    expect(mapped.output.find((item) => item.type === "reasoning")?.id).toBe("rs_1");
    expect(mapped.usage).toMatchObject({ input: 10, output: 4 });
  });

  it("replays three turns without dropping assistant text", () => {
    const call = mapResponsesApiResult({
      output: [{ type: "function_call", call_id: "c1", name: "read_file", arguments: "{\"path\":\"a.ts\"}" }],
      output_text: "",
    });
    const reply = mapResponsesApiResult({
      output: [{ type: "message", content: [{ type: "output_text", text: "The bug is in a.ts." }] }],
      output_text: "The bug is in a.ts.",
    });
    const history = [
      { role: "user", content: "fix the bug" },
      ...call.output,
      { type: "function_call_output", call_id: "c1", output: "export const x = 1;" },
      ...reply.output,
    ];
    const chat = responsesHistoryToChatMessages(history);
    const assistant = chat.filter((message) => message.role === "assistant");
    expect(JSON.stringify(assistant)).toContain("The bug is in a.ts.");
    expect(JSON.stringify(chat)).toContain("read_file");
  });
});

describe("permissions", () => {
  it("fails closed without a handler", async () => {
    const pm = new PermissionManager();
    expect(await pm.checkCommand("npm test")).toBe(false);
    expect(await pm.checkEdit("src/app.ts")).toBe(false);
  });

  it("stores the full command, not the first token", async () => {
    const pm = new PermissionManager();
    pm.allowCommand("git push");
    expect(await pm.checkCommand("git push")).toBe(true);
    expect(await pm.checkCommand("git push --force")).toBe(false);
    expect(await pm.checkCommand("git status")).toBe(false);
  });

  it("denies a compound command when any segment is dangerous", async () => {
    const pm = new PermissionManager({ allow: ["Bash(npm test:*)"] });
    expect(splitShellSegments('npm test && sudo reboot')).toEqual(["npm test", "sudo reboot"]);
    expect(await pm.checkCommand("npm test && sudo reboot")).toBe(false);
    expect(await pm.checkCommand('echo "a && b"')).toBe(false);
  });

  it("lets an Edit rule allow a path and a deny rule win", async () => {
    const pm = new PermissionManager({ allow: ["Edit(src/**)"], deny: ["Edit(src/secret.ts)"] });
    expect(await pm.checkEdit("src/app.ts")).toBe(true);
    expect(await pm.checkEdit("src/secret.ts")).toBe(false);
    const edits = new PermissionManager({ mode: "acceptEdits" });
    expect(await edits.checkEdit("anywhere.ts")).toBe(true);
  });
});

describe("edits", () => {
  let tmp: string;
  afterEach(async () => {
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  });

  it("refuses to edit a file that was never read", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ca-edit-"));
    await writeFile(tmp, "a.ts", "export const x = 1;\n");
    const cache = new FileStateCache();
    await expect(
      executeTool(tmp, "edit_file", { path: "a.ts", old_text: "x = 1", new_text: "x = 2" }, undefined, { fileStateCache: cache }),
    ).rejects.toThrow(/not read/i);
    await expect(executeTool(tmp, "write_file", { path: ".git/HEAD", content: "ref: x" })).rejects.toThrow(/protected path/i);
  });

  it("replace_all changes every exact match and multi_edit is atomic", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ca-edit-"));
    await writeFile(tmp, "a.ts", "const a = 1;\nconst a = 1;\n");
    const replaced = await editFile(tmp, "a.ts", "const a = 1;", "const a = 2;", { replaceAll: true });
    expect(replaced).toContain("replacements: 2");
    expect(await fs.readFile(path.join(tmp, "a.ts"), "utf8")).toBe("const a = 2;\nconst a = 2;\n");

    await expect(
      multiEdit(tmp, "a.ts", [
        { oldText: "const a = 2;", newText: "const a = 3;", replaceAll: true },
        { oldText: "does not exist", newText: "nope" },
      ]),
    ).rejects.toThrow(/not found/i);
    expect(await fs.readFile(path.join(tmp, "a.ts"), "utf8")).toBe("const a = 2;\nconst a = 2;\n");
  });
});

describe("compaction, models, and exit codes", () => {
  it("compacts only after the context window threshold", () => {
    const small = [{ role: "user", content: "hi" }, { role: "assistant", content: "ok" }];
    expect(shouldCompactHistory(small, 8192)).toBe(false);
    const huge = [{ role: "user", content: "x".repeat(40_000) }];
    expect(shouldCompactHistory(huge, 8192)).toBe(true);
    expect(getModelCapabilities("unknown-model-xyz").contextWindow).toBe(8192);
    expect(getModelCapabilities("claude-sonnet-4-5").contextWindow).toBeGreaterThan(8192);
  });

  it("maps stop reasons to exit codes", () => {
    expect(exitCodeForStopReason("ok")).toBe(0);
    expect(exitCodeForStopReason("stuck")).toBe(1);
    expect(exitCodeForStopReason("permission")).toBe(2);
    expect(exitCodeForStopReason("budget")).toBe(3);
    expect(exitCodeForStopReason("config")).toBe(4);
  });
});

describe("subagent inheritance and streaming", () => {
  it("uses the parent responder", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ca-sub-"));
    try {
      const responder: Responder = async () => ({ output: [], output_text: "from parent" });
      const result = await executeTool(tmp, "run_subagent", { task: "look" }, undefined, { responder });
      expect(result).toContain("from parent");
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("passes provider overrides into the subagent factory", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ca-sub-"));
    try {
      let seen = "";
      const result = await runSubagent(tmp, "look", {
        providerOverrides: { model: "custom-model", baseURL: "http://localhost:11434/v1" },
        createResponder: (overrides) => {
          seen = `${overrides?.model}|${overrides?.baseURL}`;
          return async () => ({ output: [], output_text: "ok" });
        },
      });
      expect(seen).toBe("custom-model|http://localhost:11434/v1");
      expect(result).toContain("ok");
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("collects a scripted provider stream into a responder result", async () => {
    const provider = scriptedProvider([
      { type: "text_delta", text: "Hel" },
      { type: "text_delta", text: "lo" },
      { type: "tool_call_start", id: "c1", name: "read_file" },
      { type: "tool_call_delta", id: "c1", argumentsDelta: "{\"path\":\"a.ts\"}" },
      { type: "tool_call_end", id: "c1", name: "read_file", arguments: "{\"path\":\"a.ts\"}" },
      { type: "usage", input: 3, output: 1 },
      { type: "stop", finishReason: "tool_calls" },
    ]);
    const result = await providerToResponder(provider)([]);
    expect(result.output_text).toBe("Hello");
    expect(result.finish_reason).toBe("tool_calls");
    expect(result.output.some((item) => item.type === "function_call" && item.name === "read_file")).toBe(true);
    const collected = await collectProviderEvents(provider.stream({ system: "", messages: [], tools: true }));
    expect(collected.usage).toMatchObject({ input: 3, output: 1 });
  });
});

describe("memory and renderer spike", () => {
  it("loads AGENTS.md from the repo root", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ca-mem-"));
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "ca-home-"));
    try {
      await fs.writeFile(path.join(tmp, "AGENTS.md"), "Prefer small edits.", "utf8");
      const memory = loadProjectMemory(tmp, home);
      expect(memory.some((rule) => rule.content.includes("Prefer small edits."))).toBe(true);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("renders a long stream and a diff card quickly", () => {
    const ms = measureStreamRender(5000);
    expect(ms).toBeLessThan(1500);
    expect(renderDiffCard("src/app.ts", "-1| a\n+1| b")).toContain("Yes for project rule");
  });
});
