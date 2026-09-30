import { describe, expect, it } from "vitest";
import { anthropicChunkToEvents } from "../src/llm/anthropic.js";
import { geminiChunkToEvents } from "../src/llm/gemini.js";
import { responsesChunkToEvents } from "../src/llm/responsesStream.js";
import { collectProviderEvents, providerToResponder, scriptedProvider, chatChunkToEvents } from "../src/llm/stream.js";
import { collectStreamingWithEmit } from "../src/llm/collectStream.js";
import { createReporterAdapter } from "../src/cli/ui/reporterAdapter.js";
import { isSmallModel, filterToolsForSmallModel, repairToolArgumentsJson } from "../src/llm/smallModel.js";
import { resolveModelFor, isPlanRoutedTool } from "../src/llm/modelRouting.js";
import { orderPrefixParts, withAnthropicCacheBreakpoints, supportsPromptCaching } from "../src/llm/cache.js";
import { buildSystemPrompt, promptFamilyForModel, PROMPT_VERSION } from "../src/agent/promptSections.js";
import { classifyIntentWithModel, isAmbiguousForIntent } from "../src/agent/intentModel.js";
import { cyclePermissionMode, isNetworkEgressCommand, PermissionManager } from "../src/agent/permissions.js";
import { renderMarkdownChunk, renderDiffPreview, renderStatusLine, fuzzyFilter, MessageQueue, autocompleteKindFor, renderNextEvent } from "../src/tui/next.js";
import { scoreFile } from "../src/repo/rankedMap.js";
import { extractImageMentions, isImagePath } from "../src/agent/images.js";
import { SLASH_COMMANDS, findCommand } from "../src/cli/commandRegistry.js";
import { transitionForCommand } from "../src/cli/sessionController.js";
import { collapseLargePaste, historySearch, shouldSubmitOnEnter } from "../src/cli/inputHandler.js";
import { summarizeLive } from "../eval/score.js";
import { parseNamespacedTool, namespacedToolId } from "../src/mcp/client.js";
import { detectVerifyCommands } from "../src/agent/verify.js";
import { skillContextBlock } from "../src/agent/skills.js";
import { loadHookConfig } from "../src/agent/hooks.js";

describe("remaining slice", () => {
  it("anthropic text + tool_use start folds to events", () => {
    const tools = new Map();
    const e1 = anthropicChunkToEvents({ type: "content_block_delta", delta: { type: "text_delta", text: "hi" } } as never, tools);
    expect(e1).toEqual([{ type: "text_delta", text: "hi" }]);
    const e2 = anthropicChunkToEvents({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "c1", name: "read" } } as never, tools);
    expect(e2).toEqual([{ type: "tool_call_start", id: "c1", name: "read" }]);
  });

  it("gemini text + functionCall maps to tool events then stop", () => {
    const tools = new Map();
    const ev = geminiChunkToEvents({ candidates: [{ content: { parts: [{ text: "ok" }, { functionCall: { name: "grep", args: { q: "x" } } }] }, finishReason: "STOP" }] }, tools);
    expect(ev.some((e) => e.type === "text_delta")).toBe(true);
    expect(ev.some((e) => e.type === "tool_call_start")).toBe(true);
    expect(ev[ev.length - 1]).toEqual({ type: "stop", finishReason: "stop" });
  });

  it("responses SSE text + completed folds with usage", () => {
    const tools = new Map();
    const d = responsesChunkToEvents({ type: "response.output_text.delta", delta: "hello" }, tools);
    expect(d).toEqual([{ type: "text_delta", text: "hello" }]);
    const end = responsesChunkToEvents({ type: "response.completed", response: { usage: { input_tokens: 3, output_tokens: 5 } } }, tools);
    expect(end).toContainEqual({ type: "usage", input: 3, output: 5 });
    expect(end[end.length - 1]).toEqual({ type: "stop", finishReason: "stop" });
  });

  it("collectStreamingWithEmit emits incremental deltas", async () => {
    const seen: string[] = [];
    const provider = scriptedProvider([
      { type: "text_delta", text: "a" },
      { type: "text_delta", text: "b" },
      { type: "stop", finishReason: "stop" },
    ]);
    const res = await collectStreamingWithEmit(provider, { system: "", messages: [], tools: true }, (e) => {
      if (e.type === "text_delta") seen.push(e.text);
    });
    expect(seen).toEqual(["a", "b"]);
    expect(res.output_text).toBe("ab");
  });

  it("providerToResponder collapses a scripted stream", async () => {
    const provider = scriptedProvider([{ type: "text_delta", text: "hi" }, { type: "stop", finishReason: "stop" }]);
    const respond = providerToResponder(provider);
    const res = await respond([]);
    expect(res.output_text).toBe("hi");
  });

  it("chat chunks still fold (existing path intact)", () => {
    const tools = new Map();
    const ev = chatChunkToEvents({ choices: [{ delta: { content: "x" }, finish_reason: null }] }, tools);
    expect(ev).toEqual([{ type: "text_delta", text: "x" }]);
  });

  it("reporter adapter translates turn/text/tool/usage/done", () => {
    const calls: string[] = [];
    const reporter = {
      onIterationStart: () => { calls.push("turn"); },
      onToolStart: () => { calls.push("tool_start"); },
      onToolComplete: () => { calls.push("tool_end"); },
      onProgressMessage: () => { calls.push("msg"); },
      onThinking: () => { calls.push("think"); },
      onError: () => { calls.push("error"); },
      stop: () => { calls.push("stop"); },
    };
    const emit = createReporterAdapter(reporter as never);
    emit({ type: "turn_start", turn: 1 });
    emit({ type: "text_delta", text: "Hello world. " });
    emit({ type: "tool_start", id: "1", name: "read", args: {} });
    emit({ type: "tool_end", id: "1", ok: true, output: "ok", ms: 1 });
    emit({ type: "usage", input: 1, output: 2 });
    emit({ type: "done", result: {} });
    expect(calls).toContain("turn");
    expect(calls).toContain("tool_start");
    expect(calls).toContain("tool_end");
    expect(calls).toContain("stop");
  });

  it("small-model detection, tool filter, JSON repair", () => {
    expect(isSmallModel("openai/gpt-oss-20b")).toBe(true);
    expect(isSmallModel("gpt-5.6-luna")).toBe(false);
    // Size suffixes need a digit boundary: 27B is not a 7B-class model.
    expect(isSmallModel("Qwen3.8-27B")).toBe(false);
    expect(isSmallModel("qwen2.5-coder:7b")).toBe(true);
    expect(isSmallModel("llama-8b")).toBe(true);
    expect(filterToolsForSmallModel(["read", "bash_output", "write_file"])).toEqual(["read", "write_file"]);
    expect(repairToolArgumentsJson("{'a':1,}")).toContain('"a"');
    expect(repairToolArgumentsJson("")).toBe("{}");
  });

  it("plan-role routing prefers plan model for exploration", () => {
    expect(resolveModelFor("grep", { main: "m", plan: "p" })).toBe("p");
    expect(resolveModelFor("write_file", { main: "m", plan: "p" })).toBe("m");
    expect(isPlanRoutedTool("read")).toBe(true);
    expect(isPlanRoutedTool("write_file")).toBe(false);
  });

  it("cache prefix order + breakpoints + support", () => {
    const ordered = orderPrefixParts({ system: "s", tools: [], memory: "m", history: [{ a: 1 }] });
    expect(ordered.length).toBe(4);
    const blocks = withAnthropicCacheBreakpoints([{ text: "a" }, { text: "b" }]);
    expect(blocks[1]?.cache_control).toEqual({ type: "ephemeral" });
    expect(supportsPromptCaching("claude-sonnet-4-5")).toBe(true);
    expect(supportsPromptCaching("some-local-7b")).toBe(false);
  });

  it("modular prompt is versioned and family-aware", () => {
    const p = buildSystemPrompt({ family: "anthropic" });
    expect(p.startsWith(PROMPT_VERSION)).toBe(true);
    expect(p).toContain("ANTHROPIC NOTE");
    expect(promptFamilyForModel("gemini-2.5-pro")).toBe("gemini");
    expect(promptFamilyForModel("gpt-oss-20b")).toBe("small");
  });

  it("intent second opinion falls back to regex without a model", async () => {
    expect(isAmbiguousForIntent("help me understand this")).toBe(true);
    expect(await classifyIntentWithModel("hello")).toBe("conversational");
    const fast = async () => ({ output_text: "task", output: [], finish_reason: "stop" }) as never;
    expect(await classifyIntentWithModel("please review the login flow", fast as never)).toBe("task");
  });

  it("permission cycle + egress detection", () => {
    expect(cyclePermissionMode("default")).toBe("acceptEdits");
    expect(cyclePermissionMode("bypass")).toBe("default");
    expect(isNetworkEgressCommand("git push origin main")).toBe(true);
    expect(isNetworkEgressCommand("npm test")).toBe(false);
    const pm = new PermissionManager({ mode: "default" });
    expect(pm.cycleMode()).toBe("acceptEdits");
    pm.setMode("plan");
    expect(pm.getMode()).toBe("plan");
  });

  it("next UI: markdown, diff, status, fuzzy, queue, autocomplete, events", () => {
    const md = renderMarkdownChunk("# Hi\n- a\n`code`", false);
    expect(md.text).toContain("Hi");
    const diff = renderDiffPreview("a\nb", "a\nc");
    expect(diff).toContain("+ 2");
    const status = renderStatusLine({ model: "m", branch: "main", dirty: true, contextPct: 42, costUsd: 0.01, mode: "default", sandbox: "local" });
    expect(status).toContain("model:m");
    expect(fuzzyFilter([{ n: "sessions" }, { n: "model" }], "ses", (x) => x.n).length).toBe(1);
    const q = new MessageQueue();
    q.enqueue("hello");
    expect(q.drain()).toEqual(["hello"]);
    expect(autocompleteKindFor("/rew")).toBe("command");
    expect(autocompleteKindFor("@src/x")).toBe("file");
    const r = renderNextEvent({ type: "text_delta", text: "hi" }, { codeFence: false });
    expect(r.lines.length).toBe(1);
  });

  it("ranked map scoring prefers shallow query matches", () => {
    expect(scoreFile("src/auth.ts", ["auth"], 10)).toBeGreaterThan(scoreFile("deep/nested/other.ts", ["auth"], 10));
  });

  it("image mentions parse + ext check", () => {
    expect(isImagePath("shot.png")).toBe(true);
    expect(isImagePath("doc.pdf")).toBe(false);
    expect(extractImageMentions("see @a.png and @b.jpg")).toEqual(["a.png", "b.jpg"]);
  });

  it("F-13 registry + session transitions + input helpers", () => {
    expect(SLASH_COMMANDS.length).toBeGreaterThan(20);
    expect(findCommand("rewind")?.usage).toContain("/rewind");
    expect(transitionForCommand("new", "")).toEqual({ kind: "new" });
    expect(collapseLargePaste("x".repeat(5000)).length).toBeLessThan(5000);
    expect(historySearch(["npm test", "git status"], "git")).toEqual(["git status"]);
    expect(shouldSubmitOnEnter("hello")).toBe(true);
    expect(shouldSubmitOnEnter("```\ncode", { shiftHeld: true })).toBe(false);
  });

  it("live scoring summarizes pass rate and cost", () => {
    const s = summarizeLive([
      { taskId: "a", ok: true, turns: 3, inputTokens: 10, outputTokens: 5, costUsd: 0.01, seconds: 2 },
      { taskId: "b", ok: false, turns: 5, inputTokens: 10, outputTokens: 5, costUsd: 0.02, seconds: 4 },
    ]);
    expect(s.passRate).toBe(0.5);
    expect(s.totalCostUsd).toBeCloseTo(0.03);
  });

  it("mcp namespacing round-trips", () => {
    expect(namespacedToolId("github", "search")).toBe("mcp__github__search");
    expect(parseNamespacedTool("mcp__github__search")).toEqual({ server: "github", tool: "search" });
    expect(parseNamespacedTool("read")).toBeNull();
  });

  it("skills context block + hook config loader", async () => {
    expect(skillContextBlock([])).toBe("");
    expect(skillContextBlock([{ name: "x", description: "d", body: "b", source: "s" }])).toContain("x");
    expect(loadHookConfig({})).toEqual({});
    const cmds = await detectVerifyCommands(process.cwd());
    expect(typeof cmds).toBe("object");
  });

  it("collectProviderEvents stays intact for existing fakes", async () => {
    const { scriptedProvider: sp } = await import("../src/llm/stream.js");
    const res = await collectProviderEvents(sp([{ type: "text_delta", text: "z" }, { type: "stop", finishReason: "stop" }]).stream({ system: "", messages: [], tools: true }));
    expect(res.output_text).toBe("z");
  });
});
