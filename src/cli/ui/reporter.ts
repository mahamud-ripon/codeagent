import readline from "node:readline";
import ora, { type Ora } from "ora";
import { colors, formatDuration, formatPath, icons, pc } from "./theme.js";

export interface AgentReporter {
  onIterationStart(iteration: number, maxIterations: number, phase: string): void;
  /** Display LLM thinking / reasoning text. */
  onThinking?(thinking: string, durationMs?: number): void;
  onToolStart(toolName: string, args: Record<string, unknown>): void;
  onToolComplete(
    toolName: string,
    args: Record<string, unknown>,
    output: string,
    success: boolean,
    durationMs: number,
  ): void;
  onProgressMessage(message: string): void;
  onError(message: string): void;
  stop(): void;
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
 * Collapsed: "+ Thought: 315ms  (Ctrl+T or /t to view)"
 * Expanded:  "- Thought: 315ms  (Ctrl+T or /t to collapse)\n\n  The user is saying..."
 */
export function formatThoughtLine(durationMs?: number, expanded?: boolean, text?: string): string {
  const duration = durationMs ? formatDuration(durationMs) : "done";
  const amber = (s: string) => `\x1b[38;2;230;145;50m${s}\x1b[0m`;
  const prefix = expanded ? "- Thought:" : "+ Thought:";
  const hint = expanded ? pc.dim("  (Ctrl+T or /t to collapse)") : pc.dim("  (Ctrl+T or /t to view)");
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

export function formatThinking(thinking: string): string {
  const lines = thinking.trim().split("\n");
  const header = `  ${pc.magenta("✦")} ${pc.bold(pc.dim("Thinking:"))}`;
  const body = lines.map((line) => `  ${pc.dim("│")} ${pc.dim(line)}`).join("\n");
  return `${header}\n${body}`;
}

export function formatToolSummary(toolName: string, args: Record<string, unknown>, output: string): string {
  const p = typeof args.path === "string" ? args.path : "";

  switch (toolName) {
    case "run_command": {
      const cmd = String(args.command ?? "");
      const exitMatch = output.match(/exit code:\s*(-?\d+)/i);
      const code = exitMatch ? exitMatch[1] : "0";
      return `${pc.bold(cmd)} ${code === "0" ? pc.dim("(exit 0)") : pc.red(`(exit ${code})`)}`;
    }
    case "grep_search":
    case "search": {
      const q = String(args.query ?? "");
      const lines = output.split("\n").filter((l) => l.trim().length > 0);
      return `"${q}" in ${p || "repo"} ${pc.dim(`(${lines.length} match${lines.length === 1 ? "" : "es"})`)}`;
    }
    case "view_file": {
      const start = args.start_line ? `L${args.start_line}` : "L1";
      const end = args.end_line ? `-L${args.end_line}` : "";
      return `${p} ${pc.dim(`(${start}${end})`)}`;
    }
    case "read_file":
      return `${p} ${pc.dim(`(${output.split("\n").length} lines)`)}`;
    case "edit_file": {
      const edits = Array.isArray(args.edits) ? args.edits.length : 1;
      return `${p} ${pc.dim(`(${edits} edit hunk${edits === 1 ? "" : "s"})`)}`;
    }
    case "write_file":
      return `${p} ${pc.dim(`(${output.length} bytes)`)}`;
    case "list_files":
      return `${p || "."} ${pc.dim(`(${output.split("\n").length} entries)`)}`;
    case "git_status":
      return pc.dim(output.trim().split("\n")[0] || "clean");
    case "git_diff": {
      const diffLines = output.split("\n");
      const adds = diffLines.filter((l) => l.startsWith("+") && !l.startsWith("+++")).length;
      const dels = diffLines.filter((l) => l.startsWith("-") && !l.startsWith("---")).length;
      return `${pc.green(`+${adds}`)} ${pc.red(`-${dels}`)} lines`;
    }
    default:
      return JSON.stringify(args).slice(0, 80);
  }
}

export function toolIcon(toolName: string): string {
  switch (toolName) {
    case "run_command":
      return icons.cmd;
    case "grep_search":
    case "search":
      return icons.search;
    case "view_file":
    case "read_file":
      return icons.file;
    case "edit_file":
    case "write_file":
      return icons.edit;
    default:
      return icons.sparkle;
  }
}

export class ConsoleAgentReporter implements AgentReporter {
  private spinner: Ora | null = null;
  private currentToolStartTime: number = 0;
  private currentIterationStartTime: number = 0;
  private isThinking: boolean = false;

  constructor(
    private repoRoot: string = process.cwd(),
    private autoExpandThought: boolean = false,
  ) {}

  onIterationStart(iteration: number, maxIterations: number, phase: string): void {
    this.stopSpinner();
    this.currentIterationStartTime = Date.now();
    this.isThinking = true;

    const phaseTag = pc.magenta(`[${phase}]`);
    const countTag = pc.dim(`${iteration}/${maxIterations}`);

    this.spinner = ora({
      text: `${pc.bold("Thinking...")} ${countTag} ${phaseTag}`,
      color: "cyan",
      spinner: "dots",
    }).start();
  }

  onThinking(thinking: string, durationMs?: number): void {
    if (!thinking || !thinking.trim()) return;
    this.stopSpinner();

    const duration =
      durationMs ??
      (this.currentIterationStartTime ? Date.now() - this.currentIterationStartTime : 0);
    setLatestThought({ text: thinking.trim(), durationMs: duration });

    // Render OpenCode-style thought badge (expanded or collapsed):
    console.log(`${formatThoughtLine(duration, this.autoExpandThought, thinking.trim())}\n`);
  }

  onToolStart(toolName: string, args: Record<string, unknown>): void {
    // When next step (tool execution) starts, the thinking is automatically hidden
    // as the spinner transitions to the active tool execution.
    this.currentToolStartTime = Date.now();
    const icon = toolIcon(toolName);
    const target = typeof args.path === "string" ? args.path : (args.command as string) ?? "";
    const shortTarget = target.length > 50 ? `${target.slice(0, 47)}...` : target;

    const text = `${pc.cyan(icon)} ${pc.bold(toolName)} ${pc.dim(shortTarget)}...`;
    if (this.spinner) {
      this.spinner.text = text;
      this.spinner.color = "yellow";
    } else {
      this.spinner = ora({
        text,
        color: "yellow",
        spinner: "dots",
      }).start();
    }
  }

  onToolComplete(
    toolName: string,
    args: Record<string, unknown>,
    output: string,
    success: boolean,
    durationMs: number,
  ): void {
    this.stopSpinner();
    const icon = toolIcon(toolName);
    const summary = formatToolSummary(toolName, args, output);
    const duration = pc.dim(`(${formatDuration(durationMs)})`);

    if (success) {
      console.log(`  ${pc.green(icons.check)} ${pc.cyan(icon)} ${pc.bold(toolName)}: ${summary} ${duration}`);
    } else {
      console.log(`  ${pc.red(icons.cross)} ${pc.bold(toolName)} failed: ${pc.red(summary)} ${duration}`);
    }
  }

  onProgressMessage(message: string): void {
    if (this.spinner) {
      this.spinner.text = pc.yellow(message);
    } else {
      console.log(`  ${pc.yellow(icons.info)} ${message}`);
    }
  }

  onError(message: string): void {
    this.stopSpinner();
    console.error(`  ${pc.red(icons.cross)} ${pc.bold("Error:")} ${pc.red(message)}`);
  }

  stop(): void {
    this.stopSpinner();
  }

  private stopSpinner(): void {
    if (this.spinner) {
      this.spinner.stop();
      this.spinner = null;
    }
  }
}
