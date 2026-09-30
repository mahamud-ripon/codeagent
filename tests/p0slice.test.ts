import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  isRetryableProviderError,
  parseRetryAfterMs,
  retryDelayMs,
  withProviderRetry,
} from "../src/llm/retry.js";
import { DEFAULT_MODEL, describeProviderFromEnv } from "../src/llm/provider.js";
import { getModelCapabilities } from "../src/llm/capabilities.js";
import { loadModelSettings } from "../src/agent/settings.js";
import {
  appendMemoryNote,
  generateMemoryFile,
  resolveMemoryFile,
} from "../src/agent/rules.js";
import {
  compactHistory,
  compactHistoryWithSummary,
  estimateHistoryTokens,
  estimateTokens,
} from "../src/agent/compactor.js";
import { detectNoProgress } from "../src/agent/progress.js";
import { logAudit } from "../src/agent/audit.js";
import { executeTool } from "../src/tools/index.js";
import { writeFile } from "../src/tools/filesystem.js";
import { FileStateCache } from "../src/tools/fileStateCache.js";
import type { ToolCallRecord } from "../src/agent/types.js";

function call(name: string, success: boolean, summary = "", args: Record<string, unknown> = {}): ToolCallRecord {
  return { iteration: 1, name, args, success, summary };
}

describe("provider retry (ML-2)", () => {
  it("parses Retry-After seconds, dates, and garbage", () => {
    expect(parseRetryAfterMs("2")).toBe(2000);
    expect(parseRetryAfterMs("  0 ")).toBe(0);
    const future = new Date(Date.now() + 5000).toUTCString();
    expect(parseRetryAfterMs(future)).toBeGreaterThan(0);
    expect(parseRetryAfterMs(future)).toBeLessThanOrEqual(5000);
    expect(parseRetryAfterMs("not-a-date")).toBeUndefined();
    expect(parseRetryAfterMs(null)).toBeUndefined();
  });

  it("keeps backoff bounded with jitter", () => {
    for (let i = 0; i < 20; i++) {
      const wait = retryDelayMs(3, 1000, 30_000, undefined, () => 0.999);
      expect(wait).toBeLessThanOrEqual(30_000);
    }
    expect(retryDelayMs(0, 1000, 30_000, undefined, () => 0)).toBe(0);
    expect(retryDelayMs(10, 1000, 30_000, undefined, () => 1)).toBe(30_000);
  });

  it("classifies retryable vs auth errors", () => {
    expect(isRetryableProviderError(new Error("429 rate limit exceeded"))).toBe(true);
    expect(isRetryableProviderError({ message: "boom", status: 503 })).toBe(true);
    expect(isRetryableProviderError({ message: "x", status: 400 })).toBe(false);
    expect(isRetryableProviderError(new Error("401 invalid api key"))).toBe(false);
    expect(isRetryableProviderError({ message: "ok", status: 401 })).toBe(false);
    expect(isRetryableProviderError(new Error("socket hang up"))).toBe(true);
  });

  it("retries then succeeds", async () => {
    let calls = 0;
    const waits: number[] = [];
    const result = await withProviderRetry(
      async () => {
        calls++;
        if (calls < 3) throw Object.assign(new Error("503 overloaded"), { status: 503 });
        return "ok";
      },
      { sleep: async (ms) => { waits.push(ms); }, random: () => 0 },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(3);
    expect(waits).toHaveLength(2);
  });

  it("fails fast on auth errors without retrying", async () => {
    let calls = 0;
    await expect(
      withProviderRetry(async () => {
        calls++;
        throw Object.assign(new Error("401 invalid api key"), { status: 401 });
      }, { sleep: async () => {} }),
    ).rejects.toThrow(/401/);
    expect(calls).toBe(1);
  });

  it("gives up after maxAttempts", async () => {
    let calls = 0;
    await expect(
      withProviderRetry(async () => {
        calls++;
        throw new Error("503 Service Unavailable");
      }, { maxAttempts: 3, sleep: async () => {}, random: () => 0 }),
    ).rejects.toThrow(/503/);
    expect(calls).toBe(3);
  });

  it("honors Retry-After over jittered backoff", async () => {
    const waits: number[] = [];
    let calls = 0;
    await expect(
      withProviderRetry(
        async () => {
          calls++;
          throw { message: "429 slow down", status: 429, headers: { "retry-after": "2" } };
        },
        { maxAttempts: 2, sleep: async (ms) => { waits.push(ms); }, random: () => 0 },
      ),
    ).rejects.toBeDefined();
    expect(calls).toBe(2);
    expect(waits).toEqual([2000]);
  });

  it("aborts without calling when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    await expect(
      withProviderRetry(async () => { calls++; return 1; }, { signal: controller.signal }),
    ).rejects.toThrow(/cancelled/i);
    expect(calls).toBe(0);
  });
});

describe("default model + capability overrides", () => {
  it("derives the default model from one constant", () => {
    expect(describeProviderFromEnv({} as NodeJS.ProcessEnv).model).toBe(DEFAULT_MODEL);
  });

  it("applies settings capability overrides", () => {
    expect(getModelCapabilities("unknown-xyz", { contextWindow: 5000 }).contextWindow).toBe(5000);
    expect(getModelCapabilities("gpt-5.6-luna", { maxOutput: 111 }).maxOutput).toBe(111);
    expect(getModelCapabilities("gpt-5.6-luna").contextWindow).toBeGreaterThan(5000);
  });

  it("loads model roles with last-file-wins", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ca-model-"));
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "ca-home-"));
    try {
      await fs.mkdir(path.join(home, ".codeagent"), { recursive: true });
      await fs.writeFile(
        path.join(home, ".codeagent", "settings.json"),
        JSON.stringify({ model: { main: "global-main", fast: "global-fast" } }),
        "utf8",
      );
      await fs.mkdir(path.join(tmp, ".codeagent"), { recursive: true });
      await fs.writeFile(
        path.join(tmp, ".codeagent", "settings.json"),
        JSON.stringify({ model: { fast: "project-fast", capabilities: { contextWindow: 64000 } } }),
        "utf8",
      );
      const settings = loadModelSettings(tmp, home);
      expect(settings.main).toBe("global-main");
      expect(settings.fast).toBe("project-fast");
      expect(settings.capabilities?.contextWindow).toBe(64000);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("accepts a plain-string model shorthand", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ca-model-"));
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "ca-home-"));
    try {
      await fs.mkdir(path.join(tmp, ".codeagent"), { recursive: true });
      await fs.writeFile(path.join(tmp, ".codeagent", "settings.json"), JSON.stringify({ model: "my-model" }), "utf8");
      expect(loadModelSettings(tmp, home).main).toBe("my-model");
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});

describe("unified read tool (AG-5)", () => {
  let tmp = "";
  afterEach(async () => {
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
    tmp = "";
  });

  it("reads whole files and line slices", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ca-read-"));
    await writeFile(tmp, "a.ts", "line1\nline2\nline3\nline4\n");
    const full = await executeTool(tmp, "read", { path: "a.ts" });
    expect(full).toContain("line1");
    expect(full).toContain("line4");
    const slice = await executeTool(tmp, "read", { path: "a.ts", offset: 2, limit: 2 });
    expect(slice).toContain("line2");
    expect(slice).toContain("line3");
    expect(slice).not.toContain("line4");
    // legacy aliases still work
    expect(await executeTool(tmp, "read_file", { path: "a.ts" })).toContain("line1");
    expect(await executeTool(tmp, "view_file", { path: "a.ts", start_line: 4 })).toContain("line4");
  });

  it("satisfies read-before-write through the unified tool", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ca-read-"));
    await writeFile(tmp, "a.ts", "export const x = 1;\n");
    const cache = new FileStateCache();
    await executeTool(tmp, "read", { path: "a.ts" }, undefined, { fileStateCache: cache });
    const out = await executeTool(
      tmp, "edit_file", { path: "a.ts", old_text: "x = 1", new_text: "x = 2" },
      undefined, { fileStateCache: cache },
    );
    expect(out).toContain("Edited");
  });

  it("rejects invalid ranges", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ca-read-"));
    await writeFile(tmp, "a.ts", "hi\n");
    await expect(executeTool(tmp, "read", { path: "a.ts", offset: -1 })).rejects.toThrow(/invalid arguments/i);
  });
});

describe("token-aware compaction (AG-6)", () => {
  it("estimates tokens with per-message overhead", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("x".repeat(40))).toBe(10);
    const history = [{ role: "user", content: "hi" }];
    expect(estimateHistoryTokens(history)).toBeGreaterThan(estimateTokens("hi"));
  });

  it("bounds kept recent outputs by tokens", () => {
    const history: unknown[] = [{ role: "system", content: "sys" }];
    for (let i = 0; i < 4; i++) {
      history.push({ type: "function_call", call_id: `c${i}`, name: "read", arguments: "{}" });
      history.push({ type: "function_call_output", call_id: `c${i}`, output: "y".repeat(4000) });
    }
    const compacted = compactHistory(history, {
      keepRecentToolOutputs: 4,
      keepRecentToolOutputTokens: 1500,
      maxTotalChars: 1_000_000,
    });
    const outputs = compacted.filter(
      (item) => typeof item === "object" && item !== null && (item as Record<string, unknown>).type === "function_call_output",
    ) as Array<Record<string, unknown>>;
    const newest = outputs[outputs.length - 1]!;
    expect(String(newest.output)).toContain("y".repeat(10));
    const pruned = outputs.filter((o) => String(o.output).includes("token budget"));
    expect(pruned.length).toBeGreaterThan(0);
  });

  it("uses the fast model when available and falls back on failure", async () => {
    const history: unknown[] = [{ role: "system", content: "<repository>big</repository>" }];
    for (let i = 0; i < 12; i++) {
      history.push({ role: "user", content: `task turn number ${i} with details` });
      history.push({ role: "assistant", content: `answer ${i}` });
    }
    const summarizer = async () => ({ output: [], output_text: "Worked on auth; edited login.ts." });
    const viaModel = await compactHistoryWithSummary(history, summarizer, { maxTotalChars: 200 });
    expect(JSON.stringify(viaModel)).toContain("Worked on auth");

    const failing = async () => { throw new Error("fast model down"); };
    const viaFallback = await compactHistoryWithSummary(history, failing, { maxTotalChars: 200 });
    expect(JSON.stringify(viaFallback)).toContain("compacted");
  });
});

describe("no-progress detector (AG-11)", () => {
  it("flags consecutive failures", () => {
    const verdict = detectNoProgress({
      toolCalls: [call("read", false), call("grep", false), call("glob", false), call("search", false)],
      testResults: [],
      errors: ["e1", "e2", "e3", "e4"],
      modifiedFilesCount: 0,
    });
    expect(verdict.stalled).toBe(true);
    expect(verdict.reason).toContain("4 tool calls all failed");
  });

  it("flags a failing spin with no durable effect", () => {
    const calls: ToolCallRecord[] = [];
    for (let i = 0; i < 6; i++) calls.push(call("read", true));
    calls.push(call("edit_file", false));
    calls.push(call("run_command", false));
    const verdict = detectNoProgress({
      toolCalls: calls,
      testResults: [],
      errors: ["e1", "e2", "e3"],
      modifiedFilesCount: 0,
    });
    expect(verdict.stalled).toBe(true);
  });

  it("does not flag healthy exploration or succeeding inquiry", () => {
    const reads: ToolCallRecord[] = [];
    for (let i = 0; i < 10; i++) reads.push(call("read", true));
    expect(
      detectNoProgress({ toolCalls: reads, testResults: [], errors: [], modifiedFilesCount: 0 }).stalled,
    ).toBe(false);

    const withWrites = [...reads, call("edit_file", true)];
    expect(
      detectNoProgress({ toolCalls: withWrites, testResults: [], errors: ["old", "old", "old"], modifiedFilesCount: 1 }).stalled,
    ).toBe(false);
  });

  it("flags repeated edit oscillation on the same file when errors persist", () => {
    const oscCalls: ToolCallRecord[] = [
      call("write_file", true, "", { path: "package.json" }),
      call("run_command", false),
      call("write_file", true, "", { path: "package.json" }),
      call("run_command", false),
      call("write_file", true, "", { path: "package.json" }),
    ];
    const verdict = detectNoProgress({
      toolCalls: oscCalls,
      testResults: [],
      errors: ["err1", "err2"],
      modifiedFilesCount: 1,
    });
    expect(verdict.stalled).toBe(true);
    expect(verdict.reason).toContain("Repeated modifications to 'package.json'");
  });
});

describe("audit log (SF-8)", () => {
  let tmp = "";
  afterEach(async () => {
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
    tmp = "";
  });

  it("appends redacted JSON lines", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ca-audit-"));
    logAudit(tmp, { kind: "tool", tool: "run_command", args: { command: "npm test", apiKey: "sk-secret" }, ok: true, ms: 5 });
    logAudit(tmp, { kind: "permission", tool: "command", decision: "deny" });
    const raw = await fs.readFile(path.join(tmp, ".codeagent", "audit.jsonl"), "utf8");
    const lines = raw.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("[redacted]");
    expect(lines[0]).not.toContain("sk-secret");
    expect(JSON.parse(lines[1]!).kind).toBe("permission");
  });

  it("never throws on unwritable paths", () => {
    expect(() => logAudit("\0::invalid::", { kind: "run" })).not.toThrow();
  });
});

describe("project memory shortcuts (AG-8)", () => {
  let tmp = "";
  afterEach(async () => {
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
    tmp = "";
  });

  it("creates and appends notes", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ca-mem-"));
    const file = appendMemoryNote(tmp, "Prefer pnpm for installs.");
    expect(file).toBe(resolveMemoryFile(tmp));
    expect(file.endsWith("AGENTS.md")).toBe(true);
    appendMemoryNote(tmp, "Second note.");
    const content = await fs.readFile(file, "utf8");
    expect(content).toContain("Prefer pnpm");
    expect(content).toContain("Second note.");
  });

  it("prefers an existing CODEAGENT.md", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ca-mem-"));
    await fs.writeFile(path.join(tmp, "CODEAGENT.md"), "# existing\n", "utf8");
    const file = appendMemoryNote(tmp, "hello");
    expect(file.endsWith("CODEAGENT.md")).toBe(true);
    expect(await fs.readFile(file, "utf8")).toContain("hello");
  });

  it("generates a starter file but never overwrites", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ca-mem-"));
    await fs.writeFile(tmp + "/package.json", JSON.stringify({ scripts: { test: "vitest run" } }), "utf8");
    const first = generateMemoryFile(tmp);
    expect(first.created).toBe(true);
    const content = await fs.readFile(first.file, "utf8");
    expect(content).toContain("npm test");
    const second = generateMemoryFile(tmp);
    expect(second.created).toBe(false);
    expect(second.file).toBe(first.file);
  });
});

describe("plan approval hook (AG-9)", () => {
  let tmp = "";
  afterEach(async () => {
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
    tmp = "";
  });

  it("accepts, rejects, and applies user-revised plans", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ca-plan-"));
    const { PlanModeManager } = await import("../src/agent/planMode.js");
    const manager = new PlanModeManager();
    manager.enter();

    const accepted = await executeTool(tmp, "exit_plan_mode", { plan_summary: "Do X." }, undefined, {
      planModeManager: manager,
      planApprover: async () => true,
    });
    expect(accepted).toContain("EXITED PLAN MODE");
    expect(manager.isActive()).toBe(false);

    manager.enter();
    const rejected = await executeTool(tmp, "exit_plan_mode", { plan_summary: "Do Y." }, undefined, {
      planModeManager: manager,
      planApprover: async () => false,
    });
    expect(rejected).toContain("PLAN REJECTED");
    expect(manager.isActive()).toBe(true);

    const revised = await executeTool(tmp, "exit_plan_mode", { plan_summary: "Do Z." }, undefined, {
      planModeManager: manager,
      planApprover: async () => "Do W instead.",
    });
    expect(revised).toContain("PLAN REVISED");
    expect(manager.isActive()).toBe(false);
  });
});
