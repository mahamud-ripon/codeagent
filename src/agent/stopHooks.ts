/**
 * Stop Hooks & Quality Enforcement Loop.
 *
 * Inspired by Claude Code's src/query/stopHooks.ts:
 * When the model attempts to conclude (zero tool calls), Claude Code does NOT
 * immediately exit. Instead, it runs stop hooks:
 * 1. Checks if any modified files introduced compiler / syntax errors.
 * 2. Checks if tasks in the Todo checklist remain unfinished.
 * 3. Checks if the agent forgot to exit Plan Mode.
 *
 * If any blocking error is found, turn completion is prevented and the agent
 * is forced to continue the loop to fix the errors.
 */

import { getQuickDiagnostics } from "./diagnostics.js";
import type { TodoManager } from "./todo.js";
import type { PlanModeManager } from "./planMode.js";

export interface StopHookContext {
  repoRoot: string;
  modifiedFiles: Set<string>;
  todoManager?: TodoManager;
  planModeManager?: PlanModeManager;
  hasRunDiffReview?: boolean;
}

export interface StopHookResult {
  canConclude: boolean;
  blockingErrors: string[];
}

export async function evaluateStopHooks(context: StopHookContext): Promise<StopHookResult> {
  const blockingErrors: string[] = [];

  // 1. Plan Mode check: Agent cannot conclude without exiting Plan Mode
  if (context.planModeManager?.isActive()) {
    blockingErrors.push(
      "[STOP HOOK BLOCKED]: You are currently in Plan Mode. Summarize your implementation strategy and call 'exit_plan_mode' before concluding.",
    );
  }

  // 2. Incomplete Tasks check: Agent cannot leave in-progress tasks dangling
  if (context.todoManager) {
    const active = context.todoManager.getActiveTask();
    if (active) {
      blockingErrors.push(
        `[STOP HOOK BLOCKED]: Task '${active.content}' is still marked as in_progress. Complete the task or update todo_write before concluding.`,
      );
    }
  }

  // 3. Compiler Diagnostics check: verify all modified files are syntax-clean
  for (const filePath of context.modifiedFiles) {
    try {
      const diags = await getQuickDiagnostics(context.repoRoot, filePath);
      if (diags && diags.trim()) {
        blockingErrors.push(
          `[STOP HOOK BLOCKED - Compiler Error in ${filePath}]:\n${diags}\nFix these compiler diagnostics before concluding.`,
        );
      }
    } catch {
      // Diagnostic tool best effort
    }
  }

  return {
    canConclude: blockingErrors.length === 0,
    blockingErrors,
  };
}
