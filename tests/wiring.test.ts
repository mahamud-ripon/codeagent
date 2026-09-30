import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { systemPromptForModel, createProviderFromEnv } from "../src/llm/provider.js";
import { buildSystemPrompt } from "../src/agent/promptSections.js";
import { isSmallModelMode } from "../src/llm/smallModel.js";
import { StreamingToolExecutor } from "../src/tools/streamingExecutor.js";
import { PermissionManager } from "../src/agent/permissions.js";
import { loadHooksSettings, loadSandboxSettings } from "../src/agent/settings.js";
import { imageBlocksToHistoryItems, loadImageBlocks } from "../src/agent/images.js";
import { buildInitialContext } from "../src/agent/context.js";
import { getQuickDiagnostics } from "../src/agent/diagnostics.js";
import { isVimMode, vimNextState, loadKeybindings } from "../src/tui/keybindings.js";
import { listPlugins } from "../src/extensions/plugins.js";
import { executeTool } from "../src/tools/index.js";

describe("wiring slice (0.3.0)", () => {
  it("versioned prompt defaults by family", () => {
    expect(systemPromptForModel("claude-sonnet-4-5")).toContain("ANTHROPIC NOTE");
    expect(systemPromptForModel("gemini-2.0-flash")).toContain("GEMINI NOTE");
    expect(systemPromptForModel("openai/gpt-oss-20b")).toContain("SMALL-MODEL");
    expect(buildSystemPrompt({ family: "default" }).startsWith("codeagent-prompt/")).toBe(true);
  });

  it("provider returns streaming instance + prompt for keyed backends", () => {
    const anth = createProviderFromEnv({ ANTHROPIC_API_KEY: "x" } as NodeJS.ProcessEnv, {
      model: "claude-haiku-4-5",
      provider: "anthropic",
    });
    expect(anth.providerInstance).toBeDefined();
    expect(anth.systemPrompt).toContain("codeagent-prompt/");
    const gem = createProviderFromEnv({ GEMINI_API_KEY: "x" } as NodeJS.ProcessEnv, {
      model: "gemini-2.0-flash",
      provider: "gemini",
    });
    expect(gem.providerInstance).toBeDefined();
    const resp = createProviderFromEnv({ OPENAI_API_KEY: "x" } as NodeJS.ProcessEnv, {
      model: "gpt-5.6-luna",
      provider: "openai",
    });
    expect(resp.providerInstance).toBeDefined();
    expect(resp.systemPrompt.length).toBeGreaterThan(100);
  });

  it("explicit empty env stays pure (fail-closed tests)", () => {
    expect(() => createProviderFromEnv({} as NodeJS.ProcessEnv)).toThrow();
  });

  it("small-model mode forces single-tool turns", () => {
    expect(isSmallModelMode("openai/gpt-oss-20b", {})).toBe(true);
    expect(isSmallModelMode("gpt-5.6-luna", {})).toBe(false);
    expect(isSmallModelMode("gpt-5.6-luna", { smallModel: true })).toBe(true);
  });

  it("StreamingToolExecutor is the single batching impl", () => {
    const ex = new StreamingToolExecutor();
    const batches = ex.partitionBatches([
      { id: "1", name: "read", args: {} },
      { id: "2", name: "grep", args: {} },
      { id: "3", name: "write_file", args: {} },
    ]);
    expect(batches.length).toBe(2);
    expect(batches[0]!.length).toBe(2);
    expect(batches[1]![0]!.name).toBe("write_file");
  });

  it("MCP per-tool permissions gate dispatch", async () => {
    const pm = new PermissionManager({ allow: ["MCP(github:*)"] });
    expect(await pm.checkMcp("github", "search")).toBe(true);
    const deny = new PermissionManager({ deny: ["MCP(github:*)"] });
    expect(await deny.checkMcp("github", "search")).toBe(false);
    const closed = new PermissionManager({});
    expect(await closed.checkMcp("github", "search")).toBe(false);
  });

  it("MCP unknown server fails recoverably", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codeagent-mcp-"));
    await expect(executeTool(tmp, "mcp__nosuch__tool", {}, undefined, {})).rejects.toThrow(/not configured/);
  });

  it("images: missing files are best-effort, blocks become history items", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codeagent-img-"));
    expect(await loadImageBlocks(tmp, "see @missing.png")).toEqual([]);
    const items = imageBlocksToHistoryItems(
      [{ path: "a.png", mediaType: "image/png", base64: "AAA" }],
      "see @a.png",
    );
    expect(JSON.stringify(items)).toContain("input_image");
  });

  it("context includes ranked focus + skills boundary when present", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codeagent-ctx-"));
    fs.writeFileSync(path.join(tmp, "auth.ts"), "export const x = 1;\n");
    const ctx = await buildInitialContext(tmp, [], [], "auth login");
    expect(ctx).toContain("<repository>");
    expect(ctx).toContain("<ranked_files");
    expect(ctx).toContain("auth.ts");
  });

  it("diagnostics stay null for unsupported or clean files", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codeagent-diag-"));
    fs.writeFileSync(path.join(tmp, "note.txt"), "hello\n");
    expect(await getQuickDiagnostics(tmp, "note.txt")).toBeNull();
  });

  it("hooks + sandbox settings merge without throwing", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codeagent-set-"));
    expect(loadHooksSettings(tmp)).toEqual({});
    expect(loadSandboxSettings(tmp)).toEqual({});
  });

  it("vim mode defaults off, state machine toggles", () => {
    expect(vimNextState("insert", "\x1b")).toBe("normal");
    expect(vimNextState("normal", "i")).toBe("insert");
    expect(typeof isVimMode(os.tmpdir())).toBe("boolean");
    expect(loadKeybindings(os.tmpdir())).toEqual({});
  });

  it("plugins list empty dir without throwing", async () => {
    expect(await listPlugins(os.tmpdir())).toEqual([]);
  });

  it("run_subagents fans out with a fake responder", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codeagent-fan-"));
    const fake = async () => ({ output: [], output_text: "done", finish_reason: "stop" }) as never;
    const out = await executeTool(tmp, "run_subagents", { tasks: [{ task: "a" }, { task: "b" }] }, undefined, {
      responder: fake,
    });
    expect(out).toContain("[subagent 1/2]");
    expect(out).toContain("[subagent 2/2]");
  });
});
