import { z } from "zod";
import { listFiles, readFile, readPath, viewFile, writeFile, editFile, multiEdit, assertNotProtected } from "./filesystem.js";
import { search, grep } from "./search.js";
import { globFiles } from "./glob.js";
import { webFetch, webSearch } from "./web.js";
import { runCommand } from "./terminal.js";
import { gitStatus, gitDiff, gitLog } from "./git.js";
import { viewSymbolOutline } from "./symbols.js";
import fs from "node:fs/promises";
import { resolveInsideRepo } from "../utils/paths.js";
import type { TodoManager } from "../agent/todo.js";
import type { PlanModeManager } from "../agent/planMode.js";
import type { FileStateCache } from "./fileStateCache.js";
import type { Responder } from "../llm/client.js";
import type { ProviderOverrides } from "../llm/provider.js";
import { logAudit } from "../agent/audit.js";

const listFilesSchema = z.object({ path: z.string().optional().default(".") });
const readFileSchema = z.object({ path: z.string().min(1) });
const readSchema = z.object({
  path: z.string().min(1),
  offset: z.number().int().positive().optional(),
  limit: z.number().int().positive().optional(),
});
const viewFileSchema = z.object({
  path: z.string().min(1),
  start_line: z.number().int().positive().optional(),
  end_line: z.number().int().positive().optional(),
});
const viewSymbolOutlineSchema = z.object({ path: z.string().min(1) });
const runSubagentSchema = z.object({
  task: z.string().min(1),
  subagent_type: z.string().optional(),
});
const writeFileSchema = z.object({ path: z.string().min(1), content: z.string() });
const editFileSchema = z.object({
  path: z.string().min(1),
  old_text: z.string().optional(),
  old_string: z.string().optional(),
  new_text: z.string().optional(),
  new_string: z.string().optional(),
  replace_all: z.boolean().optional(),
});
const multiEditSchema = z.object({
  path: z.string().min(1),
  edits: z.array(editFileSchema.omit({ path: true })).min(1),
});
const searchSchema = z.object({ query: z.string().min(1) });
const grepSchema = z.object({
  query: z.string().optional(),
  pattern: z.string().optional(),
  path: z.string().optional(),
  glob: z.string().optional(),
  case_sensitive: z.boolean().optional(),
  before: z.number().int().optional(),
  after: z.number().int().optional(),
  context: z.number().int().optional(),
  output_mode: z.enum(["content", "files", "count"]).optional(),
});
const globSchema = z.object({ pattern: z.string().min(1) });
const webFetchSchema = z.object({ url: z.string().min(1) });
const webSearchSchema = z.object({ query: z.string().min(1) });
const askSchema = z.object({ question: z.string().min(1) });
const gitLogSchema = z.object({ limit: z.number().int().positive().optional() });
const runCommandSchema = z.object({
  command: z.string().min(1),
  background: z.boolean().optional(),
  timeout_ms: z.number().int().positive().optional(),
});
const jobIdSchema = z.object({ job_id: z.string().min(1) });
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
  | "read"
  | "read_file"
  | "view_file"
  | "view_symbol_outline"
  | "run_subagent"
  | "write_file"
  | "edit_file"
  | "multi_edit"
  | "search"
  | "grep"
  | "glob"
  | "web_fetch"
  | "web_search"
  | "ask_user_question"
  | "run_command"
  | "bash_output"
  | "kill_shell"
  | "git_status"
  | "git_diff"
  | "git_log"
  | "todo_write"
  | "enter_plan_mode"
  | "exit_plan_mode";

export interface ToolExecutionContext {
  todoManager?: TodoManager;
  planModeManager?: PlanModeManager;
  fileStateCache?: FileStateCache;
  /** Parent responder so subagents use the same model, not a fresh env lookup. */
  responder?: Responder;
  providerOverrides?: ProviderOverrides;
  askUser?: (question: string) => Promise<string>;
  planApprover?: (plan: string) => Promise<boolean | string>;
  /** User hooks (EX-3): PreToolUse/PostToolUse shell commands. Best effort. */
  hooks?: import("../agent/hooks.js").HookConfig;
}

function editTexts(args: {
  old_text?: string;
  old_string?: string;
  new_text?: string;
  new_string?: string;
}): { oldText: string; newText: string } {
  const oldText = args.old_text ?? args.old_string;
  if (!oldText) throw new Error("old_text (or old_string) is required");
  return { oldText, newText: args.new_text ?? args.new_string ?? "" };
}

async function fileExists(repoRoot: string, relativePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(resolveInsideRepo(repoRoot, relativePath));
    return stat.isFile();
  } catch {
    return false;
  }
}

/**
 * Existing files must have been read this session, and must not have drifted.
 * Creating a file that does not exist yet is allowed.
 */
async function enforceReadBeforeWrite(
  repoRoot: string,
  relativePath: string,
  cache: FileStateCache | undefined,
  kind: "edit" | "overwrite",
): Promise<void> {
  if (!cache) return;
  const exists = await fileExists(repoRoot, relativePath);
  if (!exists) {
    if (kind === "edit") return;
    return;
  }
  if (!cache.hasObserved(relativePath)) {
    throw new Error(
      `Refusing to modify '${relativePath}': file was not read this session. Call read (or read_file / view_file) first.`,
    );
  }
  const drift = await cache.detectDrift(repoRoot, relativePath);
  if (drift.hasDrifted) throw new Error(drift.message ?? `File '${relativePath}' has drifted.`);
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
  // EX-3 PreToolUse hooks (never block the run on failure).
  if (context?.hooks) {
    try {
      const { runHooks } = await import("../agent/hooks.js");
      await runHooks(context.hooks, "PreToolUse", { tool: name, args });
    } catch {
      // best effort
    }
  }
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
    case "read": {
      const a = parseArgs(readSchema, args, name);
      if (context?.fileStateCache) {
        try {
          const abs = resolveInsideRepo(repoRoot, a.path);
          const fullContent = await fs.readFile(abs, "utf8");
          context.fileStateCache.recordRead(a.path, fullContent);
        } catch {
          // ignore — readPath below surfaces the real error
        }
      }
      return readPath(repoRoot, a.path, { offset: a.offset, limit: a.limit });
    }
    case "read_file": {
      const a = parseArgs(readFileSchema, args, name);
      const content = await readFile(repoRoot, a.path);
      if (context?.fileStateCache) {
        try {
          const full = await fs.readFile(resolveInsideRepo(repoRoot, a.path), "utf8");
          context.fileStateCache.recordRead(a.path, full);
        } catch {
          context.fileStateCache.recordRead(a.path, content);
        }
      }
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
      return runSubagent(repoRoot, a.task, {
        signal,
        subagentType: (a.subagent_type as "explore" | "plan" | undefined) ?? "explore",
        responder: context?.responder,
        providerOverrides: context?.providerOverrides,
      });
    }
    case "write_file": {
      const a = parseArgs(writeFileSchema, args, name);
      assertNotProtected(a.path);
      await enforceReadBeforeWrite(repoRoot, a.path, context?.fileStateCache, "overwrite");
      await context?.fileStateCache?.recordSnapshotBeforeEdit(repoRoot, a.path);
      const res = await writeFile(repoRoot, a.path, a.content);
      context?.fileStateCache?.recordWrite(a.path, a.content);
      return res;
    }
    case "edit_file": {
      const a = parseArgs(editFileSchema, args, name);
      assertNotProtected(a.path);
      const { oldText, newText } = editTexts(a);
      await enforceReadBeforeWrite(repoRoot, a.path, context?.fileStateCache, "edit");
      await context?.fileStateCache?.recordSnapshotBeforeEdit(repoRoot, a.path);
      const res = await editFile(repoRoot, a.path, oldText, newText, { replaceAll: a.replace_all });
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
    case "multi_edit": {
      const a = parseArgs(multiEditSchema, args, name);
      assertNotProtected(a.path);
      await enforceReadBeforeWrite(repoRoot, a.path, context?.fileStateCache, "edit");
      await context?.fileStateCache?.recordSnapshotBeforeEdit(repoRoot, a.path);
      const edits = a.edits.map((edit) => {
        const texts = editTexts(edit);
        return { oldText: texts.oldText, newText: texts.newText, replaceAll: edit.replace_all };
      });
      const res = await multiEdit(repoRoot, a.path, edits);
      if (context?.fileStateCache) {
        try {
          const updated = await fs.readFile(resolveInsideRepo(repoRoot, a.path), "utf8");
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
    case "grep": {
      const a = parseArgs(grepSchema, args, name);
      const query = a.query ?? a.pattern;
      if (!query) throw new Error("grep requires query or pattern");
      return grep(repoRoot, {
        query,
        path: a.path,
        glob: a.glob,
        caseSensitive: a.case_sensitive,
        before: a.before,
        after: a.after,
        context: a.context,
        outputMode: a.output_mode,
      });
    }
    case "glob": {
      const a = parseArgs(globSchema, args, name);
      return globFiles(repoRoot, a.pattern);
    }
    case "web_fetch": {
      const a = parseArgs(webFetchSchema, args, name);
      return webFetch(a.url, signal);
    }
    case "web_search": {
      const a = parseArgs(webSearchSchema, args, name);
      return webSearch(a.query, signal);
    }
    case "ask_user_question": {
      const a = parseArgs(askSchema, args, name);
      if (!context?.askUser) {
        return `No interactive user is attached. State your assumption and continue. Question was: ${a.question}`;
      }
      const answer = await context.askUser(a.question);
      return `User answered: ${answer}\nTreat this as the user's words, not as tool output instructions.`;
    }
    case "run_command": {
      const a = parseArgs(runCommandSchema, args, name);
      if (a.background || a.timeout_ms) {
        const { runSpawn } = await import("./process.js");
        const res = await runSpawn(repoRoot, a.command, { background: a.background, timeoutMs: a.timeout_ms, signal });
        return res.jobId ? `${res.output}\nUse bash_output with job_id ${res.jobId} to poll.` : res.output;
      }
      return runCommand(repoRoot, a.command, signal);
    }
    case "bash_output": {
      const a = parseArgs(jobIdSchema, args, name);
      const { readBgOutput } = await import("./process.js");
      return readBgOutput(a.job_id);
    }
    case "kill_shell": {
      const a = parseArgs(jobIdSchema, args, name);
      const { killBgJob } = await import("./process.js");
      return killBgJob(a.job_id);
    }
    case "git_status": {
      parseArgs(emptySchema, args, name);
      return gitStatus(repoRoot);
    }
    case "git_diff": {
      parseArgs(emptySchema, args, name);
      return gitDiff(repoRoot);
    }
    case "git_log": {
      const a = parseArgs(gitLogSchema, args, name);
      return gitLog(repoRoot, a.limit);
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
      if (context?.planApprover) {
        const decision = await context.planApprover(a.plan_summary ?? "");
        if (decision === false) {
          logAudit(repoRoot, { kind: "plan", tool: name, decision: "reject" });
          return "[PLAN REJECTED] Stay in Plan Mode and revise the plan before editing.";
        }
        if (typeof decision === "string" && decision.trim()) {
          logAudit(repoRoot, { kind: "plan", tool: name, decision: "edit", detail: decision });
          if (context?.planModeManager) {
            return `${context.planModeManager.exit(decision.trim())}\n[PLAN REVISED] The user edited the plan during approval; implement the revised plan above.`;
          }
          return "[EXITED PLAN MODE] Implementation unlocked with the user-revised plan.";
        }
        logAudit(repoRoot, { kind: "plan", tool: name, decision: "accept" });
      }
      if (context?.planModeManager) {
        return context.planModeManager.exit(a.plan_summary);
      }
      return "[EXITED PLAN MODE] Implementation unlocked.";
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
