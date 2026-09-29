import { z } from "zod";
import { listFiles, readFile, viewFile, writeFile, editFile } from "./filesystem.js";
import { search } from "./search.js";
import { runCommand } from "./terminal.js";
import { gitStatus, gitDiff } from "./git.js";
import { viewSymbolOutline } from "./symbols.js";
import fs from "node:fs/promises";
import { resolveInsideRepo } from "../utils/paths.js";
import type { TodoManager } from "../agent/todo.js";
import type { PlanModeManager } from "../agent/planMode.js";
import type { FileStateCache } from "./fileStateCache.js";

const listFilesSchema = z.object({ path: z.string().optional().default(".") });
const readFileSchema = z.object({ path: z.string().min(1) });
const viewFileSchema = z.object({
  path: z.string().min(1),
  start_line: z.number().int().positive().optional(),
  end_line: z.number().int().positive().optional(),
});
const viewSymbolOutlineSchema = z.object({ path: z.string().min(1) });
const runSubagentSchema = z.object({
  task: z.string().min(1),
  subagent_type: z.enum(["explore", "plan"]).optional(),
});
const writeFileSchema = z.object({ path: z.string().min(1), content: z.string() });
const editFileSchema = z.object({
  path: z.string().min(1),
  old_text: z.string().min(1),
  new_text: z.string(),
});
const searchSchema = z.object({ query: z.string().min(1) });
const runCommandSchema = z.object({ command: z.string().min(1) });
const todoWriteSchema = z.object({
  todos: z.array(
    z.object({
      id: z.string().optional(),
      content: z.string().min(1),
      activeForm: z.string().optional(),
      status: z.enum(["pending", "in_progress", "completed"]),
    }),
  ),
});
const enterPlanModeSchema = z.object({}).passthrough();
const exitPlanModeSchema = z.object({ plan_summary: z.string().optional() });
const emptySchema = z.object({}).passthrough();

export type ToolName =
  | "list_files"
  | "read_file"
  | "view_file"
  | "view_symbol_outline"
  | "run_subagent"
  | "write_file"
  | "edit_file"
  | "search"
  | "run_command"
  | "git_status"
  | "git_diff"
  | "todo_write"
  | "enter_plan_mode"
  | "exit_plan_mode";

export interface ToolExecutionContext {
  todoManager?: TodoManager;
  planModeManager?: PlanModeManager;
  fileStateCache?: FileStateCache;
}

function parseArgs<T>(schema: z.ZodType<T>, args: Record<string, unknown>, tool: string): T {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    throw new Error(`Invalid arguments for ${tool}: ${parsed.error.message}`);
  }
  return parsed.data;
}

/**
 * Single dispatch point for all agent tool calls.
 * Validates args with Zod so malformed model output becomes a
 * recoverable TOOL ERROR instead of a crash.
 */
export async function executeTool(
  repoRoot: string,
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
  context?: ToolExecutionContext,
): Promise<string> {
  // Validate plan mode restrictions if PlanModeManager is active
  if (context?.planModeManager) {
    const planCheck = context.planModeManager.validateToolCall(name, args);
    if (!planCheck.allowed) {
      throw new Error(planCheck.reason);
    }
  }

  switch (name as ToolName) {
    case "list_files": {
      const a = parseArgs(listFilesSchema, args, name);
      return listFiles(repoRoot, a.path);
    }
    case "read_file": {
      const a = parseArgs(readFileSchema, args, name);
      const content = await readFile(repoRoot, a.path);
      context?.fileStateCache?.recordRead(a.path, content);
      return content;
    }
    case "view_file": {
      const a = parseArgs(viewFileSchema, args, name);
      if (context?.fileStateCache) {
        try {
          const abs = resolveInsideRepo(repoRoot, a.path);
          const fullContent = await fs.readFile(abs, "utf8");
          context.fileStateCache.recordRead(a.path, fullContent);
        } catch {
          // ignore
        }
      }
      return viewFile(repoRoot, a.path, {
        startLine: a.start_line,
        endLine: a.end_line,
      });
    }
    case "view_symbol_outline": {
      const a = parseArgs(viewSymbolOutlineSchema, args, name);
      return viewSymbolOutline(repoRoot, a.path);
    }
    case "run_subagent": {
      const a = parseArgs(runSubagentSchema, args, name);
      const { runSubagent } = await import("../agent/subagent.js");
      return runSubagent(repoRoot, a.task, { signal, subagentType: a.subagent_type });
    }
    case "write_file": {
      const a = parseArgs(writeFileSchema, args, name);
      await context?.fileStateCache?.recordSnapshotBeforeEdit(repoRoot, a.path);
      const res = await writeFile(repoRoot, a.path, a.content);
      context?.fileStateCache?.recordWrite(a.path, a.content);
      return res;
    }
    case "edit_file": {
      const a = parseArgs(editFileSchema, args, name);
      // Drift detection: check if file was modified externally
      if (context?.fileStateCache) {
        const drift = await context.fileStateCache.detectDrift(repoRoot, a.path);
        if (drift.hasDrifted) {
          throw new Error(drift.message);
        }
        await context.fileStateCache.recordSnapshotBeforeEdit(repoRoot, a.path);
      }
      const res = await editFile(repoRoot, a.path, a.old_text, a.new_text);
      if (context?.fileStateCache) {
        try {
          const abs = resolveInsideRepo(repoRoot, a.path);
          const updated = await fs.readFile(abs, "utf8");
          context.fileStateCache.recordWrite(a.path, updated);
        } catch {
          // ignore
        }
      }
      return res;
    }
    case "search": {
      const a = parseArgs(searchSchema, args, name);
      return search(repoRoot, a.query);
    }
    case "run_command": {
      const a = parseArgs(runCommandSchema, args, name);
      return runCommand(repoRoot, a.command, signal);
    }
    case "git_status": {
      parseArgs(emptySchema, args, name);
      return gitStatus(repoRoot);
    }
    case "git_diff": {
      parseArgs(emptySchema, args, name);
      return gitDiff(repoRoot);
    }
    case "todo_write": {
      const a = parseArgs(todoWriteSchema, args, name);
      if (context?.todoManager) {
        return context.todoManager.setTodos(a.todos).message;
      }
      return `Updated todo list with ${a.todos.length} items.`;
    }
    case "enter_plan_mode": {
      parseArgs(enterPlanModeSchema, args, name);
      if (context?.planModeManager) {
        return context.planModeManager.enter();
      }
      return "[ENTERED PLAN MODE] File modifications locked. Call exit_plan_mode when plan is complete.";
    }
    case "exit_plan_mode": {
      const a = parseArgs(exitPlanModeSchema, args, name);
      if (context?.planModeManager) {
        return context.planModeManager.exit(a.plan_summary);
      }
      return "[EXITED PLAN MODE] Implementation unlocked.";
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
