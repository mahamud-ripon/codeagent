/**
 * Dual-Phase Plan Mode Architecture.
 *
 * Inspired by Claude Code's EnterPlanModeTool and ExitPlanModeTool:
 * - When exploring non-trivial tasks, architectural decisions, or multi-file changes,
 *   the agent enters Plan Mode.
 * - In Plan Mode, file mutation tools (edit_file, write_file) and mutating terminal commands are locked.
 * - The agent explores the codebase using read-only tools, designs an architectural plan,
 *   and presents it for user sign-off before exiting plan mode to begin implementation.
 */

export interface PlanModeState {
  active: boolean;
  enteredAt?: number;
  planSummary?: string;
}

const READ_ONLY_TOOLS = new Set([
  "list_files",
  "read_file",
  "view_file",
  "search",
  "view_symbol_outline",
  "git_status",
  "git_diff",
  "run_subagent",
  "todo_write",
  "exit_plan_mode",
]);

export class PlanModeManager {
  private state: PlanModeState = { active: false };

  isActive(): boolean {
    return this.state.active;
  }

  enter(): string {
    this.state = {
      active: true,
      enteredAt: Date.now(),
    };
    return (
      "[ENTERED PLAN MODE]\n" +
      "Mutation tools (edit_file, write_file) and modifying shell commands are now LOCKED.\n" +
      "Explore the codebase thoroughly using read_file, view_file, search, and outline tools.\n" +
      "Formulate your implementation plan. When ready to implement, summarize your plan and call exit_plan_mode."
    );
  }

  exit(summary?: string): string {
    if (!this.state.active) {
      return "Plan Mode was not active.";
    }
    this.state = {
      active: false,
      planSummary: summary,
    };
    return (
      "[EXITED PLAN MODE]\n" +
      "Implementation tools (edit_file, write_file, shell execution) are now UNLOCKED.\n" +
      "Proceed with your verified implementation strategy."
    );
  }

  validateToolCall(toolName: string, args: Record<string, unknown>): { allowed: boolean; reason?: string } {
    if (!this.state.active) {
      return { allowed: true };
    }

    if (toolName === "enter_plan_mode") {
      return { allowed: false, reason: "Already in Plan Mode. Call exit_plan_mode when plan is complete." };
    }

    if (READ_ONLY_TOOLS.has(toolName)) {
      return { allowed: true };
    }

    if (toolName === "run_command") {
      const command = String(args.command ?? "").trim();
      const isMutating = /\b(rm|mv|cp|mkdir|touch|npm\s+(i|install|publish)|git\s+(commit|push|checkout|reset|rebase|merge)|pip\s+install)\b/i.test(
        command,
      );
      if (isMutating) {
        return {
          allowed: false,
          reason: `Command '${command}' performs mutations which are locked in Plan Mode. Explore with read-only tools or call exit_plan_mode.`,
        };
      }
      return { allowed: true };
    }

    return {
      allowed: false,
      reason: `Tool '${toolName}' is locked in Plan Mode. Plan Mode only allows exploration tools (read_file, view_file, search, symbols, diff). Formulate your plan and call exit_plan_mode to unlock editing.`,
    };
  }
}
