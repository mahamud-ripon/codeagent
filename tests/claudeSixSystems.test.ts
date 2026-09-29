import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TodoManager } from "../src/agent/todo.js";
import { PlanModeManager } from "../src/agent/planMode.js";
import { evaluateStopHooks } from "../src/agent/stopHooks.js";
import {
  createWorktree,
  hasWorktreeModifications,
  removeWorktree,
  sanitizeSlug,
} from "../src/tools/worktree.js";
import {
  StreamingToolExecutor,
  isConcurrencySafeTool,
} from "../src/tools/streamingExecutor.js";
import { FileStateCache } from "../src/tools/fileStateCache.js";
import { executeTool } from "../src/tools/index.js";
import { Agent } from "../src/agent/agent.js";
import type { Responder } from "../src/llm/client.js";

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "agent-six-systems-"));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("The 6 Claude Code Core System-Level Mechanisms", () => {
  describe("1. Dynamic Todo & Progress State Machine", () => {
    it("manages todo transitions and enforces single in_progress task", () => {
      const manager = new TodoManager();
      const res = manager.setTodos([
        { id: "1", content: "Inspect code", activeForm: "Inspecting code", status: "completed" },
        { id: "2", content: "Implement feature", activeForm: "Implementing feature", status: "in_progress" },
        { id: "3", content: "Run tests", activeForm: "Running tests", status: "pending" },
      ]);

      expect(res.activeTask?.content).toBe("Implement feature");
      expect(manager.getActiveTask()?.activeForm).toBe("Implementing feature");
      expect(manager.hasIncompleteTasks()).toBe(true);

      // Concurrency rule: at most ONE in_progress task
      expect(() =>
        manager.setTodos([
          { id: "1", content: "Task 1", status: "in_progress" },
          { id: "2", content: "Task 2", status: "in_progress" },
        ]),
      ).toThrow(/at most ONE task can be in_progress/i);
    });

    it("triggers verification nudge when closing multi-step tasks without testing", () => {
      const manager = new TodoManager();
      // Setup initial tasks
      manager.setTodos([
        { id: "1", content: "Build widget", status: "in_progress" },
        { id: "2", content: "Style widget", status: "pending" },
      ]);

      // Complete all without verification task
      const result = manager.setTodos([
        { id: "1", content: "Build widget", status: "completed" },
        { id: "2", content: "Style widget", status: "completed" },
      ]);

      expect(result.verificationNudgeNeeded).toBe(true);
      expect(result.message).toContain("VERIFICATION ADVISORY");
    });

    it("executes todo_write tool through executeTool", async () => {
      const manager = new TodoManager();
      const out = await executeTool(
        tmp,
        "todo_write",
        {
          todos: [
            { content: "Fix bug", activeForm: "Fixing bug", status: "in_progress" },
          ],
        },
        undefined,
        { todoManager: manager },
      );

      expect(out).toContain("Todos have been modified successfully");
      expect(out).toContain("Updated todo list");
      expect(manager.getActiveTask()?.content).toBe("Fix bug");
      expect(manager.shouldShowInPrompt()).toBe(true);

      // Verify clearIfAllCompleted
      manager.setTodos([
        { content: "Fix bug", activeForm: "Fixing bug", status: "completed" },
      ]);
      expect(manager.clearIfAllCompleted()).toBe(true);
      expect(manager.getTodos().length).toBe(0);
    });
  });

  describe("2. Dual-Phase Plan Mode Architecture", () => {
    it("locks mutation tools in Plan Mode and unlocks upon exit", async () => {
      const planManager = new PlanModeManager();
      expect(planManager.isActive()).toBe(false);

      const enterMsg = planManager.enter();
      expect(planManager.isActive()).toBe(true);
      expect(enterMsg).toContain("ENTERED PLAN MODE");

      // Read tools are allowed
      const readCheck = planManager.validateToolCall("read_file", { path: "a.ts" });
      expect(readCheck.allowed).toBe(true);

      // Edit/write tools are blocked
      const editCheck = planManager.validateToolCall("edit_file", { path: "a.ts" });
      expect(editCheck.allowed).toBe(false);
      expect(editCheck.reason).toContain("locked in Plan Mode");

      // Mutating shell commands are blocked
      const shellCheck = planManager.validateToolCall("run_command", { command: "rm -rf foo" });
      expect(shellCheck.allowed).toBe(false);

      // Read-only shell commands are permitted
      const safeShellCheck = planManager.validateToolCall("run_command", { command: "git status" });
      expect(safeShellCheck.allowed).toBe(true);

      // Exit plan mode unlocks
      const exitMsg = planManager.exit("Architecture confirmed");
      expect(planManager.isActive()).toBe(false);
      expect(exitMsg).toContain("EXITED PLAN MODE");

      const afterExitCheck = planManager.validateToolCall("edit_file", { path: "a.ts" });
      expect(afterExitCheck.allowed).toBe(true);
    });

    it("enforces plan mode in executeTool dispatch", async () => {
      const planManager = new PlanModeManager();
      await executeTool(tmp, "enter_plan_mode", {}, undefined, { planModeManager: planManager });
      expect(planManager.isActive()).toBe(true);

      await expect(
        executeTool(
          tmp,
          "write_file",
          { path: "test.ts", content: "console.log(1);" },
          undefined,
          { planModeManager: planManager },
        ),
      ).rejects.toThrow(/locked in Plan Mode/i);

      await executeTool(tmp, "exit_plan_mode", { plan_summary: "Ready" }, undefined, {
        planModeManager: planManager,
      });
      expect(planManager.isActive()).toBe(false);
    });
  });

  describe("3. Stop Hooks & Quality Enforcement Loop", () => {
    it("blocks completion if tasks are in_progress or if in Plan Mode", async () => {
      const todoManager = new TodoManager([
        { id: "1", content: "Refactor core", activeForm: "Refactoring core", status: "in_progress" },
      ]);
      const planManager = new PlanModeManager();
      planManager.enter();

      const hookResult = await evaluateStopHooks({
        repoRoot: tmp,
        modifiedFiles: new Set(),
        todoManager,
        planModeManager: planManager,
      });

      expect(hookResult.canConclude).toBe(false);
      expect(hookResult.blockingErrors).toHaveLength(2);
      expect(hookResult.blockingErrors.some((e) => e.includes("Plan Mode"))).toBe(true);
      expect(hookResult.blockingErrors.some((e) => e.includes("Refactor core"))).toBe(true);
    });

    it("allows completion when all tasks and quality checks pass", async () => {
      const todoManager = new TodoManager([
        { id: "1", content: "Done task", status: "completed" },
      ]);
      const planManager = new PlanModeManager();

      const hookResult = await evaluateStopHooks({
        repoRoot: tmp,
        modifiedFiles: new Set(),
        todoManager,
        planModeManager: planManager,
      });

      expect(hookResult.canConclude).toBe(true);
      expect(hookResult.blockingErrors).toHaveLength(0);
    });

    it("forces agent loop to continue and self-heal when stop hook blocks completion", async () => {
      const todoManager = new TodoManager([
        { id: "1", content: "Finish task", activeForm: "Finishing task", status: "in_progress" },
      ]);

      let turn = 0;
      const responder: Responder = async (input) => {
        turn++;
        if (turn === 1) {
          // Model tries to finish prematurely with task still in_progress
          return { output: [], output_text: "I think I am done." };
        }
        // Second turn: model observes stop hook blocking message, updates task to completed
        todoManager.setTodos([{ id: "1", content: "Finish task", status: "completed" }]);
        return { output: [], output_text: "Now everything is fully completed." };
      };

      const agent = new Agent({
        repoRoot: tmp,
        model: "test",
        maxIterations: 5,
        responder,
        todoManager,
        verbose: false,
      });

      const res = await agent.run("Do the work");
      expect(turn).toBe(2);
      expect(res.finalMessage).toContain("Now everything is fully completed.");
      expect(todoManager.getActiveTask()).toBeUndefined();
    });
  });

  describe("4. Git Worktree Sandbox Isolation", () => {
    it("sanitizes slug correctly", () => {
      expect(sanitizeSlug("Feature: Add Auth!!")).toBe("feature-add-auth");
      expect(sanitizeSlug("   ")).toBe("task");
    });

    it("creates, inspects, and cleans up isolated worktree if git repo", async () => {
      // Initialize temporary git repo
      const { exec } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const execAsync = promisify(exec);

      await execAsync("git init", { cwd: tmp });
      await execAsync('git config user.name "Test"', { cwd: tmp });
      await execAsync('git config user.email "test@test.com"', { cwd: tmp });
      await fs.writeFile(path.join(tmp, "initial.txt"), "hello", "utf8");
      await execAsync('git add -A && git commit -m "Initial commit"', { cwd: tmp });

      const info = await createWorktree(tmp, "test-feature");
      expect(info.worktreePath).toContain("test-feature");
      expect(info.branch).toContain("codeagent-worktree");

      const modifiedBefore = await hasWorktreeModifications(info.worktreePath);
      expect(modifiedBefore).toBe(false);

      // Make a change in the isolated worktree
      await fs.writeFile(path.join(info.worktreePath, "feature.txt"), "isolated work", "utf8");
      const modifiedAfter = await hasWorktreeModifications(info.worktreePath);
      expect(modifiedAfter).toBe(true);

      // Clean up worktree
      await removeWorktree(tmp, "test-feature");
      const exists = await fs
        .access(info.worktreePath)
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(false);
    });
  });

  describe("5. Streaming Tool Concurrency Engine", () => {
    it("distinguishes concurrency-safe tools from exclusive mutating tools", () => {
      expect(isConcurrencySafeTool("read_file")).toBe(true);
      expect(isConcurrencySafeTool("view_file")).toBe(true);
      expect(isConcurrencySafeTool("search")).toBe(true);
      expect(isConcurrencySafeTool("list_files")).toBe(true);

      expect(isConcurrencySafeTool("edit_file")).toBe(false);
      expect(isConcurrencySafeTool("write_file")).toBe(false);
      expect(isConcurrencySafeTool("run_command")).toBe(false);
      expect(isConcurrencySafeTool("todo_write")).toBe(false);
    });

    it("partitions tool calls into parallel and sequential batches", () => {
      const executor = new StreamingToolExecutor();
      const calls = [
        { id: "1", name: "read_file", args: { path: "a.ts" } },
        { id: "2", name: "view_file", args: { path: "b.ts" } },
        { id: "3", name: "edit_file", args: { path: "a.ts", old_text: "", new_text: "" } },
        { id: "4", name: "search", args: { query: "foo" } },
      ];

      const batches = executor.partitionBatches(calls);
      expect(batches).toHaveLength(3);
      expect(batches[0]).toHaveLength(2); // read_file + view_file (parallel safe)
      expect(batches[1]).toHaveLength(1); // edit_file (exclusive mutating)
      expect(batches[2]).toHaveLength(1); // search
    });

    it("executes read-only batch concurrently with preserved order", async () => {
      const executor = new StreamingToolExecutor();
      const calls = [
        { id: "1", name: "read_file", args: { path: "1.ts" } },
        { id: "2", name: "read_file", args: { path: "2.ts" } },
      ];

      const activeExecutions: string[] = [];
      let maxConcurrent = 0;

      const results = await executor.executeAll(calls, async (call) => {
        activeExecutions.push(call.id);
        maxConcurrent = Math.max(maxConcurrent, activeExecutions.length);
        await new Promise((r) => setTimeout(r, 20));
        activeExecutions.pop();
        return {
          callId: call.id,
          name: call.name,
          output: `Content of ${call.args.path}`,
          success: true,
          durationMs: 20,
        };
      });

      expect(maxConcurrent).toBe(2); // ran in parallel!
      expect(results).toHaveLength(2);
      expect(results[0].callId).toBe("1");
      expect(results[1].callId).toBe("2");
    });
  });

  describe("6. File State Cache & Drift Detection", () => {
    it("records snapshot before edit and enables instant rollback", async () => {
      const cache = new FileStateCache();
      const testFile = path.join(tmp, "app.ts");
      await fs.writeFile(testFile, "const version = 1;\n", "utf8");

      // Record snapshot before modifying
      const snapshot = await cache.recordSnapshotBeforeEdit(tmp, "app.ts");
      expect(snapshot?.content).toBe("const version = 1;\n");
      expect(cache.getSnapshotCount("app.ts")).toBe(1);

      // Modify the file
      await fs.writeFile(testFile, "const version = 2;\n", "utf8");
      const modifiedContent = await fs.readFile(testFile, "utf8");
      expect(modifiedContent).toBe("const version = 2;\n");

      // Rollback to prior snapshot
      const rolledBack = await cache.rollback(tmp, "app.ts");
      expect(rolledBack).toBe(true);

      const restoredContent = await fs.readFile(testFile, "utf8");
      expect(restoredContent).toBe("const version = 1;\n");
    });

    it("detects external file drift when file content changes on disk", async () => {
      const cache = new FileStateCache();
      const testFile = path.join(tmp, "config.json");
      await fs.writeFile(testFile, '{"debug":false}', "utf8");

      // Agent reads file
      cache.recordRead("config.json", '{"debug":false}');

      // No drift yet
      const check1 = await cache.detectDrift(tmp, "config.json");
      expect(check1.hasDrifted).toBe(false);

      // File modified externally (e.g. by another process or editor)
      await fs.writeFile(testFile, '{"debug":true}', "utf8");

      const check2 = await cache.detectDrift(tmp, "config.json");
      expect(check2.hasDrifted).toBe(true);
      expect(check2.message).toContain("modified externally");
    });

    it("intercepts drift during edit_file execution and throws safety error", async () => {
      const cache = new FileStateCache();
      await fs.writeFile(path.join(tmp, "logic.ts"), "export const x = 10;", "utf8");

      // Record reading original content
      cache.recordRead("logic.ts", "export const x = 10;");

      // External process changes logic.ts
      await fs.writeFile(path.join(tmp, "logic.ts"), "export const x = 999;", "utf8");

      // Agent attempts edit_file with stale assumptions
      await expect(
        executeTool(
          tmp,
          "edit_file",
          { path: "logic.ts", old_text: "export const x = 10;", new_text: "export const x = 20;" },
          undefined,
          { fileStateCache: cache },
        ),
      ).rejects.toThrow(/modified externally/i);
    });
  });
});
