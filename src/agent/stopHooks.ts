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
  /** Phase 4D stopOnGreen: style is advisory, ruff --fix runs without a model turn. */
  stopOnGreen?: boolean;
  /** True when the last targeted command exited 0 with real output. */
  verificationGreen?: boolean;
  /** Temp test files that must be deleted before stop (contractTests). */
  tempTestFiles?: string[];
}

export interface StopHookResult {
  canConclude: boolean;
  blockingErrors: string[];
  /** Files auto-fixed with no model turn (ruff --fix under stopOnGreen). */
  autoFixed?: string[];
}

export async function evaluateStopHooks(context: StopHookContext): Promise<StopHookResult> {
  const blockingErrors: string[] = [];
  const autoFixed: string[] = [];
  const stopOnGreen = context.stopOnGreen ?? false;

  // 1. Plan Mode check: Agent cannot conclude without exiting Plan Mode
  // (still blocks under stopOnGreen).
  if (context.planModeManager?.isActive()) {
    blockingErrors.push(
      "[STOP HOOK BLOCKED]: You are currently in Plan Mode. Summarize your implementation strategy and call 'exit_plan_mode' before concluding.",
    );
  }

  // Temp contract-test files must be deleted before stop.
  for (const f of context.tempTestFiles ?? []) {
    try {
      const { default: fs } = await import("node:fs/promises");
      const { default: path } = await import("node:path");
      await fs.rm(path.join(context.repoRoot, f), { force: true });
    } catch {
      // best effort
    }
  }

  // 2. Incomplete Tasks check. Under stopOnGreen an open todo does not block
  // when verification is green; otherwise the historical rule applies (block
  // only when no work has started).
  if (context.todoManager) {
    const active = context.todoManager.getActiveTask();
    if (active) {
      if (stopOnGreen && (context.verificationGreen || context.modifiedFiles.size > 0)) {
        // advisory only — do not block
      } else if (context.modifiedFiles.size === 0) {
        blockingErrors.push(
          `[STOP HOOK BLOCKED]: Task '${active.content}' is still marked as in_progress. Complete the task or update todo_write before concluding.`,
        );
      }
    }
  }

  // 2b. stopOnGreen: ruff check --fix runs with no model turn on files the
  // agent wrote. Syntax still blocks; leftover style is advisory.
  if (stopOnGreen) {
    const { runRuffFix } = await import("./diagnostics.js").catch(() => ({ runRuffFix: null }));
    if (typeof runRuffFix === "function") {
      for (const filePath of context.modifiedFiles) {
        if (!filePath.endsWith(".py")) continue;
        try {
          const fixed = await (runRuffFix as (root: string, file: string) => Promise<boolean>)(context.repoRoot, filePath);
          if (fixed) autoFixed.push(filePath);
        } catch {
          // best effort
        }
      }
    }
  }

  // 3. Compiler Diagnostics check: verify all modified files are syntax-clean.
  // Under stopOnGreen, pure style (ruff non-syntax) is advisory; syntax still blocks.
  for (const filePath of context.modifiedFiles) {
    const base = filePath.toLowerCase();
    if (base.includes(".config.") || base.endsWith("package.json") || base.endsWith("tsconfig.json")) {
      continue;
    }
    try {
      const diags = await getQuickDiagnostics(context.repoRoot, filePath);
      if (diags && diags.trim()) {
        const isStyleOnly = /ruff/i.test(diags) && !/syntax|error/i.test(diags);
        if (stopOnGreen && isStyleOnly) continue;
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
    autoFixed,
  };
}
