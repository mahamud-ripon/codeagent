/**
 * Dynamic Todo & Task Progress State Machine.
 *
 * Inspired by Claude Code's TodoWriteTool:
 * - Tracks multi-step task execution with structured status transitions.
 * - Requires both imperative (content) and present continuous (activeForm) forms.
 * - Enforces concurrency rule: at most ONE task in_progress at any time.
 * - Provides structural verification nudges when closing out multi-step work without testing.
 */

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
  id?: string;
  content: string; // Imperative form: "Run unit tests"
  activeForm?: string; // Present continuous form: "Running unit tests"
  status: TodoStatus;
}

export interface TodoUpdateResult {
  todos: TodoItem[];
  activeTask?: TodoItem;
  verificationNudgeNeeded: boolean;
  message: string;
}

const VERIFICATION_PATTERN = /\b(test|tests|testing|verify|verification|typecheck|lint|validate|validation)\b/i;

export class TodoManager {
  private todos: TodoItem[] = [];

  constructor(initialTodos?: TodoItem[]) {
    if (initialTodos) {
      this.setTodos(initialTodos);
    }
  }

  getTodos(): TodoItem[] {
    return this.todos.map((t) => ({ ...t }));
  }

  getActiveTask(): TodoItem | undefined {
    return this.todos.find((t) => t.status === "in_progress");
  }

  hasIncompleteTasks(): boolean {
    return this.todos.some((t) => t.status === "in_progress" || t.status === "pending");
  }

  setTodos(newTodos: TodoItem[]): TodoUpdateResult {
    // 1. Validate items
    if (!Array.isArray(newTodos)) {
      throw new Error("todos must be an array");
    }

    const sanitized: TodoItem[] = newTodos.map((item, idx) => {
      if (!item || typeof item !== "object") {
        throw new Error(`Invalid todo item at index ${idx}`);
      }
      const id = String(item.id || `todo-${idx + 1}`);
      const content = String(item.content || "").trim();
      const activeForm = String(item.activeForm || content).trim();
      const status = (item.status as TodoStatus) || "pending";

      if (!content) {
        throw new Error(`Todo item at index ${idx} is missing 'content' description`);
      }
      if (!["pending", "in_progress", "completed"].includes(status)) {
        throw new Error(`Invalid status '${status}' for todo '${content}'`);
      }

      return { id, content, activeForm: activeForm || content, status };
    });

    // 2. Concurrency rule: at most ONE task in_progress
    const inProgressItems = sanitized.filter((t) => t.status === "in_progress");
    if (inProgressItems.length > 1) {
      throw new Error(
        `At most ONE task can be in_progress at any time. Currently in_progress: ${inProgressItems
          .map((t) => `"${t.content}"`)
          .join(", ")}`,
      );
    }

    // 3. Verification Nudge: if closing out 2+ tasks and none was a verification task
    const oldHadMultiple = this.todos.length >= 2;
    const allNowCompleted = sanitized.length > 0 && sanitized.every((t) => t.status === "completed");
    const hadVerificationStep = sanitized.some((t) => VERIFICATION_PATTERN.test(t.content));
    const verificationNudgeNeeded = oldHadMultiple && allNowCompleted && !hadVerificationStep;

    this.todos = sanitized;
    const active = this.getActiveTask();
    const completedCount = sanitized.filter((t) => t.status === "completed").length;

    let message = `Todos have been modified successfully. Updated todo list: ${sanitized.length} tasks (${completedCount} completed, ${active ? `1 active: "${active.activeForm}"` : "0 in progress"}). Ensure that you continue to use the todo list to track your progress. Please proceed with the current tasks if applicable`;

    if (verificationNudgeNeeded) {
      message +=
        "\n\n[VERIFICATION ADVISORY]: You completed all implementation tasks without a verification/testing step. Run tests or build verification before concluding.";
    }

    return {
      todos: this.getTodos(),
      activeTask: active,
      verificationNudgeNeeded,
      message,
    };
  }

  clear(): void {
    this.todos = [];
  }

  clearIfAllCompleted(): boolean {
    if (this.todos.length > 0 && this.todos.every((t) => t.status === "completed")) {
      this.todos = [];
      return true;
    }
    return false;
  }

  shouldShowInPrompt(): boolean {
    return this.todos.length > 0;
  }

  formatForDisplay(): string {
    if (this.todos.length === 0) return "No active tasks.";
    return this.todos
      .map((t) => {
        const mark =
          t.status === "completed" ? "[x]" : t.status === "in_progress" ? "[>]" : "[ ]";
        const label = t.status === "in_progress" ? `${t.activeForm}...` : t.content;
        return `${mark} ${label}`;
      })
      .join("\n");
  }
}

