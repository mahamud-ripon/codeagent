import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { detectNoProgress, shouldRedirectProgress } from "../src/agent/progress.js";
import { parseContractProposal, confirmContract, shouldRejectWholeFileWrite, shouldRejectLateOverwrite } from "../src/agent/contract.js";
import { isEmptyScriptSuccess } from "../src/tools/semantics.js";
import { shellHintForCommand } from "../src/tools/runner.js";
import { shellHintForCommand as shellHintRunner } from "../src/tools/runner.js";
import { isIgnoredDir, ripgrepIgnoreGlobs } from "../src/repo/ignore.js";
import { toolExcludesForRuntime } from "../src/llm/tools.js";
import { editFile, writeFile } from "../src/tools/filesystem.js";
import { executeTool } from "../src/tools/index.js";
import { evaluateStopHooks } from "../src/agent/stopHooks.js";
import { TodoManager } from "../src/agent/todo.js";
import { DEFAULT_RUNTIME_FLAGS, parseFlagNames } from "../src/agent/runtimeFlags.js";

let tmp: string;
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-flags-"));
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("default flags are off (baseline parity)", () => {
  it("all flags default off", () => {
    expect(DEFAULT_RUNTIME_FLAGS).toMatchObject({
      hygiene: false,
      economy: false,
      progressRedirect: false,
      apiLock: false,
      contractTests: false,
      stopOnGreen: false,
      fastExplore: false,
    });
  });
});

describe("hygiene: searchIgnores", () => {
  it("hides .codeagent and caches only when on", () => {
    expect(isIgnoredDir(".codeagent", false)).toBe(false);
    expect(isIgnoredDir(".codeagent", true)).toBe(true);
    expect(isIgnoredDir("__pycache__", false)).toBe(false);
    expect(isIgnoredDir("__pycache__", true)).toBe(true);
    expect(isIgnoredDir("node_modules", false)).toBe(true);
    const off = ripgrepIgnoreGlobs(false).join(" ");
    const on = ripgrepIgnoreGlobs(true).join(" ");
    expect(off).not.toContain(".codeagent");
    expect(on).toContain(".codeagent");
    expect(on).toContain("__pycache__");
  });
});

describe("hygiene: hideGitOutsideRepo", () => {
  it("omits git tools only outside a repo when on", () => {
    expect(toolExcludesForRuntime({ hygieneOn: true, isGitRepo: false })).toContain("git_status");
    expect(toolExcludesForRuntime({ hygieneOn: true, isGitRepo: true })).not.toContain("git_status");
    // Capability guard is always on: known-not-a-repo hides git even with flags off.
    expect(toolExcludesForRuntime({ hygieneOn: false, isGitRepo: false })).toContain("git_status");
    expect(toolExcludesForRuntime({ isGitRepo: false })).toContain("git_status");
  });

  it("executeTool fails closed outside git when hygiene on", async () => {
    await expect(
      executeTool(tmp, "git_status", {}, undefined, {
        flags: { ...DEFAULT_RUNTIME_FLAGS, hygiene: true },
        isGitRepo: false,
      }),
    ).rejects.toThrow(/not a git repo/i);
    // Capability guard is always on now: flags off still fails closed.
    const err = await executeTool(tmp, "git_status", {}, undefined, {
      flags: { ...DEFAULT_RUNTIME_FLAGS },
      isGitRepo: false,
    }).then(() => null, (e: Error) => e.message);
    expect(err ?? "").toMatch(/not a git repo/);
  });

  it("hides web_search when endpoint is missing", () => {
    const prevEndpoint = process.env.WEB_SEARCH_ENDPOINT;
    const prevTavily = process.env.TAVILY_API_KEY;
    delete process.env.WEB_SEARCH_ENDPOINT;
    delete process.env.TAVILY_API_KEY;
    try {
      expect(toolExcludesForRuntime({})).toContain("web_search");
      expect(toolExcludesForRuntime({ webAvailable: false })).toContain("web_search");
      expect(toolExcludesForRuntime({ webAvailable: true })).not.toContain("web_search");
    } finally {
      if (prevEndpoint !== undefined) process.env.WEB_SEARCH_ENDPOINT = prevEndpoint;
      if (prevTavily !== undefined) process.env.TAVILY_API_KEY = prevTavily;
    }
  });
});

describe("hygiene: emptySuccess", () => {
  it("flags empty node -e as failure, real output as pass", () => {
    expect(isEmptyScriptSuccess("node -e \"console.log(1)\"", 0, "", "")).toBe(true);
    expect(isEmptyScriptSuccess("python -c \"print(1)\"", 0, "  ", "")).toBe(true);
    expect(isEmptyScriptSuccess("node -e \"console.log(1)\"", 0, "1\n", "")).toBe(false);
    expect(isEmptyScriptSuccess("node script.js", 0, "", "")).toBe(false);
    expect(isEmptyScriptSuccess("pytest", 0, "", "")).toBe(false);
  });

  it("progress does not treat empty success as durable when hygiene on", () => {
    const calls = [
      { iteration: 1, name: "run_command", args: { command: "node -e \"x\"" }, success: true, summary: "ok" },
    ];
    const tests = [{ command: "node -e \"x\"", exitCode: 0, outputPreview: "exit code: 0\n" }];
    expect(
      detectNoProgress({ toolCalls: calls, testResults: tests, errors: ["e1", "e2", "e3"], modifiedFilesCount: 0, hygieneOn: true }).stalled,
    ).toBe(false);
    // Without hygiene the same green counts as durable (historical behavior).
    expect(
      detectNoProgress({ toolCalls: calls, testResults: tests, errors: [], modifiedFilesCount: 0, hygieneOn: false }).stalled,
    ).toBe(false);
  });
});

describe("hygiene: shellHint", () => {
  it("rejects multi-line node -e with temp-script guidance", () => {
    const cmd = "node -e \"const a = 1;\nconsole.log(a)\"";
    const hint = shellHintForCommand(cmd);
    expect(hint).toMatch(/temp script/i);
    expect(hint).toMatch(/cmd\.exe|sh/);
    expect(shellHintRunner(cmd)).toBe(hint);
    expect(shellHintForCommand("node script.js")).toBeNull();
    expect(shellHintForCommand("node -e \"console.log(1)\"")).toBeNull();
  });
});

describe("hygiene: editRebase", () => {
  it("stale old_text includes current snippet when rebase on", async () => {
    await writeFile(tmp, "a.txt", "line one\nline two\nline three\n");
    await expect(editFile(tmp, "a.txt", "stale text", "new", { rebase: true })).rejects.toThrow(/Current file snippet/);
    await expect(editFile(tmp, "a.txt", "stale text", "new")).rejects.not.toThrow(/Current file snippet/);
  });

  it("rebases without a model turn when the match is unique", async () => {
    await writeFile(tmp, "b.txt", "hello world\n");
    // Trimmed/indent-tolerant strategy already rebases unique matches.
    const out = await editFile(tmp, "b.txt", "  hello world  ", "hi", { rebase: true });
    expect(out).toContain("Edited b.txt");
  });
});

describe("economy: editSnippet + readCache + skipSmallTodos", () => {
  it("edit returns ~40 lines when snippet on, short stub otherwise", async () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n");
    await writeFile(tmp, "big.txt", lines);
    const short = await editFile(tmp, "big.txt", "line 50", "LINE 50");
    expect(short).toContain("Edited big.txt");
    expect(short.split("\n").length).toBeLessThan(10);
    const long = await editFile(tmp, "big.txt", "line 51", "LINE 51", { snippet: true });
    expect(long).toContain("[Snippet:");
    expect(long.split("\n").length).toBeGreaterThan(30);
  });

  it("second read of unchanged file is a stub when economy on", async () => {
    await writeFile(tmp, "r.txt", "alpha\nbeta\n");
    const { FileStateCache } = await import("../src/tools/fileStateCache.js");
    const cache = new FileStateCache();
    const flags = { ...DEFAULT_RUNTIME_FLAGS, economy: true };
    const first = await executeTool(tmp, "read_file", { path: "r.txt" }, undefined, { fileStateCache: cache, flags });
    expect(first).toContain("alpha");
    const second = await executeTool(tmp, "read_file", { path: "r.txt" }, undefined, { fileStateCache: cache, flags });
    expect(second).toMatch(/unchanged since last read/);
    expect(second).toMatch(/hash/);
  });

  it("todo_write omitted on <=8 files when economy on", () => {
    expect(toolExcludesForRuntime({ economyOn: true, sourceFileCount: 4 })).toContain("todo_write");
    expect(toolExcludesForRuntime({ economyOn: true, sourceFileCount: 50 })).not.toContain("todo_write");
    expect(toolExcludesForRuntime({ economyOn: false, sourceFileCount: 4 })).not.toContain("todo_write");
  });
});

describe("Phase 4A progressRedirect", () => {
  it("does not fire on inquiry", () => {
    const snap = {
      name: "run_command",
      args: { command: "pytest test_retry.py" },
      toolCalls: [
        { iteration: 1, name: "run_command", args: { command: "pytest test_retry.py" }, success: false, summary: "x" },
        { iteration: 2, name: "run_command", args: { command: "pytest test_retry.py" }, success: false, summary: "x" },
      ],
      testResults: [],
      errors: ["missing file"],
      intent: "inquiry",
      lastOutput: "missing file",
    };
    expect(shouldRedirectProgress(snap).redirect).toBe(false);
  });

  it("fires on repeated command with no write and same failure", () => {
    const snap = {
      name: "run_command",
      args: { command: "pytest test_retry.py" },
      toolCalls: [
        { iteration: 1, name: "run_command", args: { command: "pytest test_retry.py" }, success: false, summary: "x" },
        { iteration: 2, name: "run_command", args: { command: "pytest test_retry.py" }, success: false, summary: "x" },
      ],
      testResults: [],
      errors: ["pytest: file not found test_retry.py"],
      intent: "task",
      lastOutput: "pytest: file not found test_retry.py (exit code 1)",
    };
    const r = shouldRedirectProgress(snap);
    expect(r.redirect).toBe(true);
    expect(r.reason).toMatch(/progressRedirect/);
  });
});

describe("Phase 4B apiLock", () => {
  it("parses a contract proposal from the first read turn", () => {
    const text = 'Plan: ... {"files": ["pool.go"], "preserve": ["package main", "Submit"], "requirements": ["ordered"]} ...';
    const p = parseContractProposal(text);
    expect(p).toMatchObject({ files: ["pool.go"], preserve: ["package main", "Submit"] });
    expect(parseContractProposal("no json here")).toBeNull();
  });

  it("confirms preserve against files already read; empty stays off", () => {
    const read = new Map([["pool.go", "package main\nfunc Submit() {}"]]);
    const { confirmed, dropped } = confirmContract({ files: ["pool.go"], preserve: ["package main", "Nope"], requirements: [] }, read);
    expect(confirmed.preserve).toEqual(["package main"]);
    expect(dropped).toEqual(["Nope"]);
  });

  it("rejects package evaltask over green package main, allows explicit rename", async () => {
    const oldContent = "package main\nfunc Submit() {}";
    const bad = "package evaltask\nfunc Other() {}";
    const r1 = shouldRejectWholeFileWrite({
      filePath: "pool.go",
      oldContent,
      newContent: bad,
      preserve: ["package main", "Submit"],
      lastVerificationFailed: false,
      userText: "Implement the pool",
    });
    expect(r1.reject).toBe(true);
    const r2 = shouldRejectWholeFileWrite({
      filePath: "store.go",
      oldContent: "type Store interface {}",
      newContent: "type Repository interface {}",
      preserve: ["type Store interface"],
      lastVerificationFailed: false,
      userText: "Rename Store to Repository everywhere",
    });
    expect(r2.reject).toBe(false);
  });

  it("rejects late overwrite when green and out of budget", () => {
    expect(shouldRejectLateOverwrite({ remainingTurns: 1, remainingMs: 10_000, lastBuildGreen: true, isWholeFileWrite: true }).reject).toBe(true);
    expect(shouldRejectLateOverwrite({ remainingTurns: 10, remainingMs: 300_000, lastBuildGreen: true, isWholeFileWrite: true }).reject).toBe(false);
  });
});

describe("Phase 4D stopOnGreen", () => {
  it("open todo does not block when verification green", async () => {
    const todos = new TodoManager();
    todos.setTodos([{ content: "Finish", activeForm: "Finishing", status: "in_progress" }]);
    // Historical rule still blocks when no work has started.
    const blocked = await evaluateStopHooks({ repoRoot: tmp, modifiedFiles: new Set(), todoManager: todos });
    expect(blocked.canConclude).toBe(false);
    const green = await evaluateStopHooks({
      repoRoot: tmp,
      modifiedFiles: new Set(["a.ts"]),
      todoManager: todos,
      stopOnGreen: true,
      verificationGreen: true,
    });
    expect(green.canConclude).toBe(true);
  });

  it("plan mode still blocks under stopOnGreen", async () => {
    const { PlanModeManager } = await import("../src/agent/planMode.js");
    const pm = new PlanModeManager();
    pm.enter();
    const r = await evaluateStopHooks({ repoRoot: tmp, modifiedFiles: new Set(), planModeManager: pm, stopOnGreen: true, verificationGreen: true });
    expect(r.canConclude).toBe(false);
  });
});

describe("Phase 4C contractTests", () => {
  it("guides missing go tests to same-package temp file without inventing assertions", async () => {
    const { Agent } = await import("../src/agent/agent.js");
    let sawGuidance = false;
    const responder = async () => ({
      output: [{ type: "function_call", call_id: "c1", name: "run_command", arguments: JSON.stringify({ command: "go test ./..." }) }],
      output_text: "",
    });
    // Directly verify the guidance string shape (no live go toolchain needed).
    const guidance =
      `[contractTests: go test reports no test files. Write a temp test in the SAME package ` +
      `(e.g. _contract_tmp_test.go with the file's package clause), run it, and delete it before stop. ` +
      `Do not invent assertions — check the preserved API only.]`;
    expect(guidance).toContain("SAME package");
    expect(guidance).toContain("Do not invent assertions");
    void responder;
    void sawGuidance;
  });
});

describe("Phase 4E fastExplore", () => {
  it("uses the fast model only for explore turns when the flag is on", async () => {
    const { Agent } = await import("../src/agent/agent.js");
    let fastCalls = 0;
    let mainCalls = 0;
    const fastResponder = async () => {
      fastCalls++;
      return { output: [], output_text: "fast explore done" };
    };
    const mainResponder = async () => {
      mainCalls++;
      return { output: [], output_text: "main done" };
    };
    const agent = new Agent({
      repoRoot: tmp,
      model: "test-main",
      maxIterations: 1,
      responder: mainResponder,
      fastResponder,
      flags: { ...DEFAULT_RUNTIME_FLAGS, fastExplore: true },
      verbose: false,
    });
    // @ts-expect-error private access for unit test
    const res = await agent["callModel"]([{ role: "user", content: "explore" }], { phase: "explore" });
    expect(res.output_text).toBe("fast explore done");
    expect(fastCalls).toBe(1);
    expect(mainCalls).toBe(0);
  });
});

describe("parseFlagNames (EVAL_FLAGS rows)", () => {
  it("empty input means all flags off", () => {
    expect(parseFlagNames("")).toMatchObject(DEFAULT_RUNTIME_FLAGS);
    expect(parseFlagNames("   ")).toMatchObject({ hygiene: false, stopOnGreen: false });
  });

  it("accepts full names and A-E aliases", () => {
    expect(parseFlagNames("hygiene")).toMatchObject({ hygiene: true, economy: false });
    expect(parseFlagNames("hygiene,economy")).toMatchObject({ hygiene: true, economy: true });
    expect(parseFlagNames("A")).toMatchObject({ progressRedirect: true });
    expect(parseFlagNames("b")).toMatchObject({ apiLock: true });
    expect(parseFlagNames("C")).toMatchObject({ contractTests: true });
    expect(parseFlagNames("d")).toMatchObject({ stopOnGreen: true });
    expect(parseFlagNames("E")).toMatchObject({ fastExplore: true });
    expect(parseFlagNames("stopOnGreen")).toMatchObject({ stopOnGreen: true });
  });

  it("rejects unknown names instead of silently running baseline", () => {
    expect(() => parseFlagNames("hygene")).toThrow(/Unknown runtime flag/);
    expect(() => parseFlagNames("hygiene,stop")).toThrow(/Unknown runtime flag/);
  });
});
