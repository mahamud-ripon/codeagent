import { formatDuration, formatPath, icons, pc, renderJumpToBottomBadge, renderStatusDock, stringWidth } from "./theme.js";

import type { TodoItem } from "../../agent/todo.js";

// stripAnsi moved to theme.ts; re-exported here so existing import paths keep working.
export { stripAnsi } from "./theme.js";

export interface AgentReporter {
  onIterationStart(iteration: number, maxIterations: number, phase: string): void;
  /** Display LLM thinking / reasoning text. */
  onThinking?(thinking: string, durationMs?: number): void;
  onToolStart(toolName: string, args: Record<string, unknown>, activeTask?: string): void;
  onToolComplete(
    toolName: string,
    args: Record<string, unknown>,
    output: string,
    success: boolean,
    durationMs: number,
  ): void;
  onTodoUpdate?(todos: TodoItem[], message?: string): void;
  onPlanModeChange?(active: boolean, plan?: string): void;
  onProgressMessage(message: string): void;
  onError(message: string): void;
  stop(): void;
  onRulesLoaded?(rules: { filePath: string }[]): void;
  onThinkingRollup?(summary: { durationMs: number; filesRead?: number; dirsListed?: number; loadedRules?: string[] }): void;
  onInterStepMonologue?(message: string): void;
  onTurnComplete?(durationMs: number): void;
  setEstimatedTokens?(tokens: number): void;
  onJumpToBottom?(): void;
  suspend?(): void;
  resume?(): void;
  setIsAutoMode?(auto: boolean): void;
}

export interface ThoughtRecord {
  text: string;
  durationMs: number;
}

export let latestThought: ThoughtRecord | null = null;

export function setLatestThought(thought: ThoughtRecord | null): void {
  latestThought = thought;
}

/**
 * Formats the OpenCode-style collapsed / expanded thought badge.
 * Collapsed: "+ Thought: 315ms  (Ctrl+O or /t to view)"
 * Expanded:  "- Thought: 315ms  (Ctrl+O or /t to collapse)\n\n  The user is saying..."
 */
export function formatThoughtLine(durationMs?: number, expanded?: boolean, text?: string): string {
  const duration = durationMs ? formatDuration(durationMs) : "done";
  const amber = (s: string) => `\x1b[38;2;230;145;50m${s}\x1b[0m`;
  const prefix = expanded ? "- Thought:" : "+ Thought:";
  const hint = expanded ? pc.dim("  (Ctrl+O or /t to collapse)") : pc.dim("  (Ctrl+O or /t to view)");
  const header = `  ${amber(`${prefix} ${duration}`)}${hint}`;
  if (expanded && text) {
    const body = text
      .trim()
      .split("\n")
      .map((l) => `    ${pc.dim(l)}`)
      .join("\n");
    return `${header}\n\n${body}`;
  }
  return header;
}

/**
 * Claude Code style tool display: short names (Read, Edit, Bash, Search)
 * with a per-category colored ⏺ bullet.
 */
export interface ToolStyle {
  display: string;
  color: (s: string) => string;
}

const READ_ONLY_DISPLAYS: Record<string, string> = {
  read_file: "Read",
  view_file: "Read",
  list_files: "List",
  view_symbol_outline: "Outline",
  git_status: "GitStatus",
  git_diff: "Diff",
};

export function toolStyle(toolName: string): ToolStyle {
  switch (toolName) {
    case "edit_file":
    case "multi_edit":
      return { display: "Edit", color: (s) => pc.yellow(s) };
    case "write_file":
      return { display: "Write", color: (s) => pc.yellow(s) };
    case "run_command":
      return { display: "Bash", color: (s) => pc.magenta(s) };
    case "search":
    case "grep":
    case "grep_search":
    case "glob":
      return { display: "Search", color: (s) => pc.cyan(s) };
    case "run_subagent":
      return { display: "Task", color: (s) => pc.magenta(s) };
    case "todo_write":
      return { display: "Todo", color: (s) => pc.green(s) };
    case "enter_plan_mode":
      return { display: "PlanMode(on)", color: (s) => pc.green(s) };
    case "exit_plan_mode":
      return { display: "PlanMode(off)", color: (s) => pc.green(s) };
    default:
      return { display: READ_ONLY_DISPLAYS[toolName] ?? toolName, color: (s) => pc.blue(s) };
  }
}

/** Short target shown in parentheses on the card header: path, command, query... */
function cardTarget(toolName: string, args: Record<string, unknown>): string {
  switch (toolName) {
    case "run_command":
      return String(args.command ?? "");
    case "search":
    case "grep_search":
      return `"${String(args.query ?? "")}"`;
    case "run_subagent": {
      const t = String(args.task ?? "");
      return t.length > 40 ? `${t.slice(0, 40)}…` : t;
    }
    case "git_status":
    case "git_diff":
    case "todo_write":
    case "enter_plan_mode":
    case "exit_plan_mode":
      return "";
    default:
      return typeof args.path === "string" ? args.path : "";
  }
}

/** One-line result summary for the ⎿ line of a tool card (no target repetition). */
export function formatToolSummary(toolName: string, args: Record<string, unknown>, output: string): string {
  switch (toolName) {
    case "run_command": {
      const exitMatch = output.match(/exit code:\s*(-?\d+)/i);
      return `exit ${exitMatch ? exitMatch[1] : "0"}`;
    }
    case "search":
    case "grep_search": {
      const lines = output.split("\n").filter((l) => l.trim().length > 0);
      return `${lines.length} match${lines.length === 1 ? "" : "es"}`;
    }
    case "view_file": {
      const start = args.start_line ? `L${args.start_line}` : "L1";
      const end = args.end_line ? `-L${args.end_line}` : "";
      return `${start}${end}`;
    }
    case "read_file":
      return `${output.split("\n").length} lines`;
    case "edit_file": {
      const edits = Array.isArray(args.edits) ? args.edits.length : 1;
      return `${edits} hunk${edits === 1 ? "" : "s"} applied`;
    }
    case "write_file":
      return `${output.length} bytes written`;
    case "list_files":
      return `${output.split("\n").length} entries`;
    case "view_symbol_outline":
      return `${output.split("\n").filter(Boolean).length} symbols`;
    case "git_status":
      return output.trim().split("\n")[0] || "clean";
    case "git_diff": {
      const diffLines = output.split("\n");
      const adds = diffLines.filter((l) => l.startsWith("+") && !l.startsWith("+++")).length;
      const dels = diffLines.filter((l) => l.startsWith("-") && !l.startsWith("---")).length;
      return `+${adds} -${dels} lines`;
    }
    case "todo_write": {
      const list = Array.isArray(args.todos) ? (args.todos as { status?: string }[]) : [];
      const completed = list.filter((t) => t.status === "completed").length;
      return `updated ${list.length} tasks (${completed} done)`;
    }
    case "enter_plan_mode":
      return "read-only exploration locked";
    case "exit_plan_mode":
      return "unlocked for modifications";
    case "run_subagent":
      return "findings delivered to context";
    default:
      return output.trim().split("\n")[0]?.slice(0, 80) || "done";
  }
}

/**
 * Claude Code style two-line tool card:
 *
 *   ⏺ Read(src/cli/repl.ts)
 *     ⎿ 45 lines (120ms)
 *
 * `run_command` cards append up to two dim preview lines of output.
 */
export function renderToolCard(
  toolName: string,
  args: Record<string, unknown>,
  output: string,
  success: boolean,
  durationMs: number,
): string {
  const style = toolStyle(toolName);
  const target = cardTarget(toolName, args);
  const bullet = success ? style.color("⏺") : pc.red("⏺");
  const head = `${bullet} ${pc.bold(style.display)}${target ? pc.dim(`(${target})`) : ""}`;

  const summary = formatToolSummary(toolName, args, output);
  const resultLine = `  ${pc.dim("⎿")} ${success ? pc.dim(summary) : pc.red(`✗ ${summary}`)} ${pc.dim(`(${formatDuration(durationMs)})`)}`;

  let card = `${head}\n${resultLine}`;

  if (toolName === "run_command" && output) {
    const preview = output
      .split("\n")
      .filter((l) => l.trim().length > 0 && !/^exit code:/i.test(l))
      .slice(0, 2)
      .map((l) => (l.length > 90 ? `${l.slice(0, 87)}…` : l));
    for (const line of preview) {
      card += `\n    ${pc.dim(line)}`;
    }
  }

  return card;
}

export const ACTION_VERBS = [
  "Whirring..",
  "Garnishing..",
  "Meandering..",
  "Simmering..",
  "Brewing..",
  "Sifting..",
  "Pondering..",
  "Deliberating..",
  "Marinating..",
  "Sauteing..",
  "Seasoning..",
  "Synthesizing..",
];

export const CLAUDE_TIPS = [
  'Say "fan out subagents" and Claude sends a team. Each one digs deep so nothing gets missed.',
  "Press Ctrl+O or /t to view the model's internal thinking stream.",
  "Use /plan to lock read-only exploration before editing files.",
  "Type /undo to instantly revert every file change made in the last task.",
  "Run /worktree create <slug> to run risky changes in an isolated git worktree.",
  "Press Esc to interrupt execution at any time.",
  "Use /compact to trim context memory when a session grows long.",
];

/**
 * Point 4: Claude Code style hierarchical tool execution:
 *   • Listing files in project directory   2s
 *     L $ ls -la
 *   • Reading amazon-clone\tsconfig.json
 *     L amazon-clone\tsconfig.json
 */
export function formatClaudeToolHierarchy(
  toolName: string,
  args: Record<string, unknown>,
  output: string,
  success: boolean,
  durationMs: number,
): string {
  const duration = durationMs >= 1000 ? `   ${pc.dim(formatDuration(durationMs))}` : "";
  let actionTitle = "";
  let branchDetail = "";

  switch (toolName) {
    case "run_command": {
      const cmd = String(args.command ?? "");
      actionTitle = "Running command";
      if (/npm (run )?test|vitest|jest/i.test(cmd)) actionTitle = "Running test suite";
      else if (/npm (run )?build|tsc/i.test(cmd)) actionTitle = "Building project";
      else if (/ls|dir/i.test(cmd)) actionTitle = "Listing files in directory";
      else if (/git status/i.test(cmd)) actionTitle = "Checking git status";
      else if (/git diff/i.test(cmd)) actionTitle = "Checking git diff";
      branchDetail = `$ ${cmd}`;
      break;
    }
    case "read_file":
    case "view_file": {
      const p = String(args.path ?? "");
      actionTitle = `Reading ${p}`;
      branchDetail = p;
      break;
    }
    case "list_files": {
      const p = String(args.path || "project directory");
      actionTitle = `Listing files in ${p}`;
      branchDetail = `$ ls -la ${p}`;
      break;
    }
    case "edit_file": {
      const p = String(args.path ?? "");
      actionTitle = `Editing ${p}`;
      const edits = Array.isArray(args.edits) ? args.edits.length : 1;
      branchDetail = `${p} (${edits} hunk applied)`;
      break;
    }
    case "write_file": {
      const p = String(args.path ?? "");
      actionTitle = `Writing ${p}`;
      branchDetail = p;
      break;
    }
    case "search":
    case "grep_search": {
      const q = String(args.query ?? "");
      actionTitle = "Searching codebase";
      branchDetail = `grep "${q}"`;
      break;
    }
    case "view_symbol_outline": {
      const p = String(args.path ?? "");
      actionTitle = `Inspecting symbol outline in ${p}`;
      branchDetail = p;
      break;
    }
    default: {
      actionTitle = `Executing ${toolName}`;
      branchDetail = JSON.stringify(args).slice(0, 60);
      break;
    }
  }

  const bullet = success ? pc.white("•") : pc.red("•");
  const head = `${bullet} ${pc.bold(actionTitle)}${duration}`;
  const branch = `  ${pc.dim("L")} ${pc.dim(branchDetail)}`;

  return `${head}\n${branch}`;
}

/**
 * Point 5: Monologue roll-up:
 *   Thought for 1m 16s, read 10 files, listed 14 directories
 *     L Loaded C:\Users\...\coding-style.md
 */
export function formatThinkingRollup(summary: {
  durationMs: number;
  filesRead?: number;
  dirsListed?: number;
  loadedRules?: string[];
}): string {
  const parts: string[] = [];
  parts.push(`Thought for ${formatDuration(summary.durationMs)}`);
  if (summary.filesRead && summary.filesRead > 0) {
    parts.push(`read ${summary.filesRead} file${summary.filesRead === 1 ? "" : "s"}`);
  }
  if (summary.dirsListed && summary.dirsListed > 0) {
    parts.push(`listed ${summary.dirsListed} director${summary.dirsListed === 1 ? "y" : "ies"}`);
  }

  const lines: string[] = [pc.dim(parts.join(", "))];
  if (summary.loadedRules && summary.loadedRules.length > 0) {
    for (const rule of summary.loadedRules) {
      lines.push(`  ${pc.dim("L")} ${pc.dim(`Loaded ${rule}`)}`);
    }
  }
  return lines.join("\n");
}

/**
 * Point 6: Turn completion line:
 *   * Cooked for 2m 10s · done 10:13 PM
 *   * Worked for 4s · done 10:10 PM
 */
export function formatTurnCompletionLine(durationMs: number, doneAt?: Date): string {
  const d = doneAt ?? new Date();
  const timeStr = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const durationStr = formatDuration(durationMs);
  const verb = durationMs >= 10_000 ? "Cooked for" : "Worked for";
  const terracotta = (s: string) => `\x1b[38;2;227;100;70m${s}\x1b[0m`;
  return `${terracotta("*")} ${pc.bold(`${verb} ${durationStr}`)} ${pc.dim(`· done ${timeStr}`)}`;
}

export interface RenderTodoListOptions {
  bordered?: boolean;
  currentActivity?: string;
}

/**
 * Formats a live task list matching Claude Code's exact TaskListV2 TUI design:
 * - Summary Header: `<total> tasks (<done> done, <inProgress> in progress, <open> open)`
 * - Glyphs (figures):
 *   - completed: `✔` (figures.tick in bright green)
 *   - in_progress: `▪` (figures.squareSmallFilled in claude amber: \x1b[38;2;217;119;6m)
 *   - pending: `▫` (figures.squareSmall in dim gray)
 * - Text styling: strikethrough & dim for completed, bold for in_progress, dim for pending
 * - Live activity line: indented underneath in-progress task with ellipsis
 */
export function renderTodoList(
  todos: TodoItem[],
  options?: RenderTodoListOptions,
): string {
  if (!todos || todos.length === 0) return "";

  const completedCount = todos.filter((t) => t.status === "completed").length;
  const inProgressCount = todos.filter((t) => t.status === "in_progress").length;
  const pendingCount = todos.filter((t) => t.status === "pending").length;

  const claudeAmber = (s: string) => `\x1b[38;2;217;119;6m${s}\x1b[0m`;

  const counts: string[] = [
    `${pc.bold(String(completedCount))} done`,
  ];
  if (inProgressCount > 0) {
    counts.push(`${pc.bold(String(inProgressCount))} in progress`);
  }
  counts.push(`${pc.bold(String(pendingCount))} open`);

  const summaryHeader = `${pc.bold(String(todos.length))} tasks (${counts.join(", ")})`;
  const bordered = options?.bordered ?? false;

  const lines: string[] = [];
  if (bordered) {
    lines.push(pc.cyan(`╭─ Current Tasks: ${summaryHeader} ─────────────────────────────╮`));
  } else {
    // Exact Claude Code TaskListV2 header: indented 2 spaces, dim with bold numbers
    lines.push(`  ${pc.dim(summaryHeader)}`);
  }

  todos.forEach((t, i) => {
    let icon = pc.dim("▫");
    let text = pc.dim(t.content);

    if (t.status === "completed") {
      icon = pc.green("✔");
      const strike = pc.strikethrough ? pc.strikethrough(t.content) : t.content;
      text = pc.dim(strike);
    } else if (t.status === "in_progress") {
      icon = claudeAmber("▪");
      text = pc.bold(t.content);
    }

    if (bordered) {
      const num = pc.dim(`${i + 1}.`);
      lines.push(`│  ${icon} ${num} ${text}`);
      if (t.status === "in_progress" && options?.currentActivity) {
        lines.push(`│     ${pc.dim(`${options.currentActivity}…`)}`);
      }
    } else {
      // Exact Claude Code TaskItem format: indented 2 spaces, icon, space, text (no numbers)
      lines.push(`  ${icon} ${text}`);
      if (t.status === "in_progress" && options?.currentActivity) {
        lines.push(`    ${pc.dim(`${options.currentActivity}…`)}`);
      }
    }
  });

  if (bordered) {
    lines.push(pc.cyan("╰──────────────────────────────────────────────────────────────────╯"));
  }

  return lines.join("\n");
}

/**
 * One-line compact task summary shown in the sticky footer when the task
 * view is collapsed (Ctrl+T / /todos toggle).
 */
export function renderCompactTodoSummary(todos: TodoItem[]): string {
  const completed = todos.filter((t) => t.status === "completed").length;
  const inProgress = todos.filter((t) => t.status === "in_progress").length;
  const open = todos.length - completed - inProgress;
  return `  ${pc.dim(`✻ ${todos.length} tasks (${completed} done, ${inProgress} in progress, ${open} open)`)}`;
}

export function countTerminalLines(
  text: string,
  columns: number = (typeof process !== "undefined" && process.stdout?.columns) || 80,
): number {
  if (!text) return 0;
  let count = 0;
  for (const line of text.split("\n")) {
    const visibleLength = stringWidth(line);
    count += Math.max(1, Math.ceil(visibleLength / columns) || 1);
  }
  return count;
}

export class ConsoleAgentReporter implements AgentReporter {
  private currentToolStartTime: number = 0;
  private currentIterationStartTime: number = 0;
  private taskStartTime: number = 0;
  private estimatedTokens: number = 0;
  private thoughtDurationMs: number = 0;
  private filesReadCount: number = 0;
  private dirsListedCount: number = 0;
  private tipIndex: number = 0;
  private lastTipSwitch: number = 0;
  private isThinking: boolean = false;
  private activePhase?: { iteration: number; maxIterations: number; phase: string };
  private activeTool?: { toolName: string; args: Record<string, unknown>; activeTask?: string };
  private statusMessage: string = "";
  private todos: TodoItem[] = [];
  private todosExpanded: boolean = true;
  private footerLinesDrawn: number = 0;
  private linesPrintedThisTurn: number = 0;
  private spinnerTimer: NodeJS.Timeout | null = null;
  private spinnerFrameIdx: number = 0;
  private spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  private isAutoMode: boolean = false;
  private isSuspended: boolean = false;

  constructor(
    private repoRoot: string = process.cwd(),
    private autoExpandThought: boolean = false,
    initialTodos: TodoItem[] = [],
  ) {
    if (initialTodos && initialTodos.length > 0) {
      this.todos = [...initialTodos];
    }
  }

  startTask(): void {
    this.taskStartTime = Date.now();
    this.estimatedTokens = 0;
    this.thoughtDurationMs = 0;
    this.filesReadCount = 0;
    this.dirsListedCount = 0;
    this.linesPrintedThisTurn = 0;
    this.lastTipSwitch = Date.now();
  }

  onJumpToBottom(): void {
    this.linesPrintedThisTurn = 0;
    if (process.stdout?.isTTY) {
      this.renderFooter();
    }
  }

  setEstimatedTokens(tokens: number): void {
    this.estimatedTokens = tokens;
    if (this.isThinking || this.activeTool) {
      this.renderFooter();
    }
  }

  /** Toggle between the full sticky task list and a compact one-line summary. */
  setTodosExpanded(expanded: boolean): void {
    this.todosExpanded = expanded;
    this.renderFooter();
  }

  /** Short display target for the active tool: repo-relative path or raw command. */
  private toolTarget(): string {
    if (!this.activeTool) return "";
    const raw = cardTarget(this.activeTool.toolName, this.activeTool.args);
    if (typeof this.activeTool.args.path === "string") {
      return formatPath(raw, this.repoRoot);
    }
    return raw;
  }

  private buildFooter(): string {
    const parts: string[] = [];

    // 1. Sticky Task List (TaskListV2 component pinned at bottom)
    if (this.todos.length > 0) {
      let currentActivity: string | undefined;
      if (this.activeTool) {
        currentActivity = `${this.activeTool.toolName} ${this.toolTarget()}`.trim();
      }
      if (this.todosExpanded) {
        const renderedTasks = renderTodoList(this.todos, {
          currentActivity: currentActivity ? (currentActivity.length > 50 ? `${currentActivity.slice(0, 47)}…` : currentActivity) : undefined,
        });
        if (renderedTasks) {
          parts.push(renderedTasks);
        }
      } else {
        // Compact one-line summary when the task view is collapsed (Ctrl+T).
        parts.push(renderCompactTodoSummary(this.todos));
      }
    }

    // 2. Point 3: Active status line / Action Verbs & Spinner row
    if (this.isThinking || this.activeTool) {
      const now = Date.now();
      const startTime = this.taskStartTime || this.currentIterationStartTime || now;
      const elapsedSec = Math.max(1, Math.round((now - startTime) / 1000));

      // Rotate action verbs every 8 seconds
      const verbIdx = Math.floor(elapsedSec / 8) % ACTION_VERBS.length;
      const verb = ACTION_VERBS[verbIdx];

      // Rotate tips every 7 seconds
      if (now - this.lastTipSwitch > 7000) {
        this.tipIndex = (this.tipIndex + 1) % CLAUDE_TIPS.length;
        this.lastTipSwitch = now;
      }
      const currentTip = CLAUDE_TIPS[this.tipIndex];

      const terracotta = (s: string) => `\x1b[38;2;227;100;70m${s}\x1b[0m`;
      const asterisk = terracotta("*");

      let statsBadge = "";
      if (this.estimatedTokens > 0) {
        const thoughtSec = Math.round(this.thoughtDurationMs / 1000);
        statsBadge = pc.dim(` (${elapsedSec}s · ${this.estimatedTokens} tokens${thoughtSec > 0 ? ` · thought for ${thoughtSec}s` : ""})`);
      } else if (elapsedSec >= 2) {
        statsBadge = pc.dim(` (${elapsedSec}s · ${this.isThinking ? "thinking" : "executing"})`);
      }

      parts.push(`  ${asterisk} ${pc.bold(verb)}${statsBadge}`);
      parts.push(`    ${pc.dim("L Tip:")} ${pc.dim(currentTip)}`);
    } else if (this.statusMessage) {
      parts.push(`  ${this.statusMessage}`);
    }

    // Point 7: Floating "Jump to bottom (Ctrl+End) ↓" badge shown when terminal output has exceeded viewport
    const cols = process.stdout?.columns || 80;
    const rows = process.stdout?.rows || 24;
    if (this.linesPrintedThisTurn > rows) {
      parts.push(renderJumpToBottomBadge(cols));
    }

    // Border line separating content from the sticky footer dock
    parts.push(pc.dim("─".repeat(cols)));

    // 3. Point 8: Status dock row (manual mode on / auto mode on / plan mode on)
    const isPlan = this.activePhase?.phase === "plan";
    const dock = renderStatusDock({
      mode: isPlan ? "plan" : this.isAutoMode ? "auto" : "manual",
      isRunning: Boolean(this.isThinking || this.activeTool),
    });
    parts.push(`  ${dock}`);

    return parts.join("\n");
  }

  setIsAutoMode(auto: boolean): void {
    this.isAutoMode = auto;
    this.renderFooter();
  }

  suspend(): void {
    this.isSuspended = true;
    this.stopSpinnerTimer();
    this.clearFooter();
  }

  resume(): void {
    this.isSuspended = false;
    this.syncSpinnerTimer();
    this.renderFooter();
  }

  private clearFooter(): void {
    if (!process.stdout?.isTTY || this.footerLinesDrawn === 0) {
      this.footerLinesDrawn = 0;
      return;
    }
    // Move up by footerLinesDrawn and clear to end of screen
    process.stdout.write(`\r\x1b[${this.footerLinesDrawn}A\x1b[0J`);
    this.footerLinesDrawn = 0;
  }

  private renderFooter(): void {
    if (!process.stdout?.isTTY || this.isSuspended) {
      return;
    }
    const footerText = this.buildFooter();
    if (!footerText) {
      this.clearFooter();
      return;
    }

    this.clearFooter();
    process.stdout.write(footerText + "\n");
    this.footerLinesDrawn = countTerminalLines(footerText);
  }

  private printLog(line: string): void {
    this.linesPrintedThisTurn += countTerminalLines(line);
    if (process.stdout?.isTTY) {
      this.clearFooter();
      process.stdout.write(line.endsWith("\n") ? line : line + "\n");
      this.renderFooter();
    } else {
      console.log(line);
    }
  }

  private startSpinnerTimer(): void {
    if (this.spinnerTimer || !process.stdout?.isTTY) return;
    this.spinnerTimer = setInterval(() => {
      this.spinnerFrameIdx++;
      if (this.isThinking || this.activeTool) {
        this.renderFooter();
      }
    }, 80);
    this.spinnerTimer.unref();
  }

  private stopSpinnerTimer(): void {
    if (this.spinnerTimer) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = null;
    }
  }

  /**
   * Runs the spinner interval only while something is actually animating
   * (thinking or an active tool); stops it on idle transitions so the
   * process isn't woken every 80ms for nothing.
   */
  private syncSpinnerTimer(): void {
    if (this.isSuspended) {
      this.stopSpinnerTimer();
      return;
    }
    if (this.isThinking || this.activeTool) {
      this.startSpinnerTimer();
    } else {
      this.stopSpinnerTimer();
    }
  }

  onIterationStart(iteration: number, maxIterations: number, phase: string): void {
    if (!this.taskStartTime) this.taskStartTime = Date.now();
    this.currentIterationStartTime = Date.now();
    this.isThinking = true;
    this.activePhase = { iteration, maxIterations, phase };
    this.activeTool = undefined;
    this.statusMessage = "";
    this.syncSpinnerTimer();
    this.renderFooter();
  }

  onThinking(thinking: string, durationMs?: number): void {
    if (!thinking || !thinking.trim()) return;
    this.isThinking = false;

    const duration =
      durationMs ??
      (this.currentIterationStartTime ? Date.now() - this.currentIterationStartTime : 0);
    this.thoughtDurationMs += duration;
    setLatestThought({ text: thinking.trim(), durationMs: duration });

    const line = `${formatThoughtLine(duration, this.autoExpandThought, thinking.trim())}\n`;
    this.printLog(line);
    this.syncSpinnerTimer();
  }

  onToolStart(toolName: string, args: Record<string, unknown>, activeTask?: string): void {
    this.isThinking = false;
    this.currentToolStartTime = Date.now();
    this.activeTool = { toolName, args, activeTask };
    this.statusMessage = "";
    this.syncSpinnerTimer();
    this.renderFooter();
  }

  onToolComplete(
    toolName: string,
    args: Record<string, unknown>,
    output: string,
    success: boolean,
    durationMs: number,
  ): void {
    this.activeTool = undefined;
    if (toolName === "read_file" || toolName === "view_file") {
      this.filesReadCount++;
    } else if (toolName === "list_files") {
      this.dirsListedCount++;
    }

    // For todo_write, onTodoUpdate already rendered the task checklist beautifully,
    // matching Claude Code where renderToolUseMessage() returns null.
    if (toolName === "todo_write" && success) {
      this.syncSpinnerTimer();
      this.renderFooter();
      return;
    }

    // Point 4: Claude Code hierarchical format:
    // • Listing files in project directory   2s
    //   L $ ls -la
    this.printLog(formatClaudeToolHierarchy(toolName, args, output, success, durationMs));
    this.syncSpinnerTimer();
  }

  onRulesLoaded(rules: { filePath: string }[]): void {
    if (!rules || rules.length === 0) return;
    for (const r of rules) {
      this.printLog(`  ${pc.dim("L")} ${pc.dim(`Loaded ${r.filePath}`)}`);
    }
  }

  onThinkingRollup(summary: { durationMs: number; filesRead?: number; dirsListed?: number; loadedRules?: string[] }): void {
    const text = formatThinkingRollup({
      durationMs: summary.durationMs,
      filesRead: summary.filesRead ?? this.filesReadCount,
      dirsListed: summary.dirsListed ?? this.dirsListedCount,
      loadedRules: summary.loadedRules,
    });
    this.printLog(text);
  }

  onInterStepMonologue(message: string): void {
    const terracotta = (s: string) => `\x1b[38;2;227;100;70m${s}\x1b[0m`;
    this.printLog(`${terracotta("*")} ${pc.dim(message)}`);
  }

  onTodoUpdate(todos: TodoItem[], message?: string): void {
    this.todos = todos;
    if (process.stdout?.isTTY) {
      // Re-renders the sticky footer in-place with zero flicker!
      this.renderFooter();
      if (message) {
        this.printLog(pc.cyan(`  [Todo] ${message}`));
      }
    } else {
      const rendered = renderTodoList(todos);
      if (rendered) {
        console.log(`\n${rendered}\n`);
      }
      if (message) {
        console.log(pc.cyan(`  [Todo] ${message}`));
      }
    }
  }

  onPlanModeChange(active: boolean, plan?: string): void {
    // Single-line banner with computed padding (no hand-aligned borders).
    const bannerLine = (text: string, color: (s: string) => string): string => {
      const inner = 54;
      const pad = Math.max(1, inner - text.length);
      return [
        color(`╭${"─".repeat(inner + 1)}╮`),
        color(`│ ${text}${" ".repeat(pad)}│`),
        color(`╰${"─".repeat(inner + 1)}╯`),
      ].join("\n");
    };

    let msg = "";
    if (active) {
      msg = `\n${bannerLine("✻ PLAN MODE · read-only exploration enabled", (s) => pc.cyan(s))}\n`;
    } else {
      msg = `\n${bannerLine("✔ PLAN APPROVED · modifications unlocked", (s) => pc.green(s))}\n`;
      if (plan) {
        msg += pc.dim("  Plan:\n") + plan.split("\n").map((l) => "    " + pc.dim(l)).join("\n");
      }
    }
    this.printLog(msg);
  }

  onProgressMessage(message: string): void {
    this.statusMessage = message;
    if (process.stdout?.isTTY) {
      this.renderFooter();
    } else {
      console.log(`  ${pc.yellow(icons.info)} ${message}`);
    }
  }

  onError(message: string): void {
    this.printLog(`  ${pc.red(icons.cross)} ${pc.bold("Error:")} ${pc.red(message)}`);
  }

  stop(): void {
    this.stopSpinnerTimer();
    this.isThinking = false;
    this.activeTool = undefined;
    this.statusMessage = "";
    this.clearFooter();
  }
}
