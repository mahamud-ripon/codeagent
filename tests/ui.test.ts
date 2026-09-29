import { describe, expect, it } from "vitest";
import {
  formatDuration,
  formatPath,
  formatMarkdown,
  formatDiff,
  formatToolSummary,
  formatUserMessage,
  formatThoughtLine,
  ConsoleAgentReporter,
  renderCompactTodoSummary,
  renderTodoList,
  renderToolCard,
  stringWidth,
  echoLineCount,
  toolStyle,
} from "../src/cli/ui/index.js";
import { pickWelcomeTips } from "../src/cli/ui/banner.js";

describe("UI Theme & Helpers", () => {
  it("formats durations accurately", () => {
    expect(formatDuration(450)).toBe("450ms");
    expect(formatDuration(1200)).toBe("1.2s");
    expect(formatDuration(2560)).toBe("2.6s");
  });

  it("formats relative paths", () => {
    const formatted = formatPath("D:/Codeagent/src/index.ts", "D:/Codeagent");
    expect(formatted).toBe("src\\index.ts".replace("/", "\\"));
  });

  it("formats user prompt as a full-width background bar", () => {
    const bar = formatUserMessage("hello", 60);
    expect(bar).toContain("hello");
    expect(bar).toContain(" > ");
  });

  it("uses TrueColor background only when the terminal advertises 24-bit color", () => {
    const prev = process.env.COLORTERM;
    try {
      process.env.COLORTERM = "truecolor";
      const truecolorBar = formatUserMessage("hello", 60);
      expect(truecolorBar).toContain("\x1b[48;2;45;49;58m");
      expect(truecolorBar).not.toContain("\x1b[48;5;237m");

      process.env.COLORTERM = "";
      const fallbackBar = formatUserMessage("hello", 60);
      expect(fallbackBar).toContain("\x1b[48;5;237m");
      expect(fallbackBar).not.toContain("\x1b[48;2;45;49;58m");
    } finally {
      process.env.COLORTERM = prev;
    }
  });

  it("pads the message bar using display width (double-width chars count as 2 cells)", () => {
    // Width floor is 40 cols: prefix " > " (3) + "你好" (4 cells) -> 33 spaces of padding.
    const bar = formatUserMessage("你好", 20);
    const pad = bar.match(/你好( +)\x1b\[0m/);
    expect(pad).not.toBeNull();
    expect(pad![1].length).toBe(33);
  });
});

describe("stringWidth", () => {
  it("counts ASCII as one cell per character", () => {
    expect(stringWidth("hello")).toBe(5);
    expect(stringWidth("")).toBe(0);
  });

  it("strips ANSI escape sequences before counting", () => {
    expect(stringWidth("\x1b[31mhi\x1b[0m")).toBe(2);
    expect(stringWidth("\x1b[38;2;230;145;50m+ Thought\x1b[0m")).toBe(9);
  });

  it("counts CJK and emoji as two cells", () => {
    expect(stringWidth("你好")).toBe(4);
    expect(stringWidth("📋")).toBe(2);
    expect(stringWidth("run 你好 now")).toBe(12);
  });

  it("skips zero-width joiners and variation selectors", () => {
    expect(stringWidth("a\u200Db")).toBe(2);
    expect(stringWidth("📋\uFE0F")).toBe(2); // wide emoji + VS16 stays 2 cells
  });
});

describe("echoLineCount", () => {
  it("returns 1 for short single-line echo", () => {
    expect(echoLineCount("▲ > ", "hi", 80)).toBe(1);
  });

  it("counts wrapped lines for long input", () => {
    // 4 (prompt) + 78 = 82 cells -> 2 lines at 80 cols.
    expect(echoLineCount("▲ > ", "a".repeat(78), 80)).toBe(2);
    // 4 + 76 = 80 cells exactly -> still 1 line (delayed wrap).
    expect(echoLineCount("▲ > ", "a".repeat(76), 80)).toBe(1);
    // 4 + 156 = 160 -> exactly 2 lines.
    expect(echoLineCount("▲ > ", "a".repeat(156), 80)).toBe(2);
  });

  it("treats non-positive column counts as 80", () => {
    expect(echoLineCount("▲ > ", "a".repeat(85), 0)).toBe(2);
  });

  it("accounts for double-width input characters", () => {
    // 4 (prompt) + 78 CJK chars * 2 cells = 160 cells -> 2 lines at 80 cols.
    expect(echoLineCount("▲ > ", "你".repeat(78), 80)).toBe(2);
  });
});

describe("UI Markdown & Diff Formatter", () => {
  it("formats markdown headings and lists", () => {
    const md = "# Main Title\n\n## Sub Title\n\n- Item 1\n- Item 2";
    const formatted = formatMarkdown(md);
    expect(formatted).toContain("Main Title");
    expect(formatted).toContain("Sub Title");
    expect(formatted).toContain("Item 1");
    expect(formatted).toContain("•");
  });

  it("formats code blocks with styled borders", () => {
    const md = "```ts\nconst x = 10;\n```";
    const formatted = formatMarkdown(md);
    expect(formatted).toContain("ts");
    expect(formatted).toContain("const");
  });

  it("renders an unclosed code block (truncated response) with borders", async () => {
    const { stripAnsi } = await import("../src/cli/ui/reporter.js");
    const formatted = formatMarkdown("```python\ndef hello():\n    return 'world'");
    const stripped = stripAnsi(formatted);
    expect(stripped).toContain("╭──");
    expect(stripped).toContain("def hello():");
    expect(stripped).toContain("╰");
  });

  it("does not recolor keywords inside string literals", async () => {
    const { stripAnsi } = await import("../src/cli/ui/reporter.js");
    const formatted = formatMarkdown("```js\nconst msg = \"return value\";\n```");
    const stripped = stripAnsi(formatted);
    expect(stripped).toContain('const msg = "return value";');
  });

  it("formats unified diffs with color tokens", () => {
    const diff = "--- a/file.ts\n+++ b/file.ts\n@@ -1,3 +1,3 @@\n-const a = 1;\n+const a = 2;";
    const formatted = formatDiff(diff);
    expect(formatted).toContain("-const a = 1;");
    expect(formatted).toContain("+const a = 2;");
  });
});

describe("UI Reporter Tool Cards (Claude Code style)", () => {
  it("resolves tool display names and colors", () => {
    expect(toolStyle("read_file").display).toBe("Read");
    expect(toolStyle("view_file").display).toBe("Read");
    expect(toolStyle("run_command").display).toBe("Bash");
    expect(toolStyle("edit_file").display).toBe("Edit");
    expect(toolStyle("write_file").display).toBe("Write");
    expect(toolStyle("search").display).toBe("Search");
    expect(toolStyle("run_subagent").display).toBe("Task");
    expect(toolStyle("todo_write").display).toBe("Todo");
  });

  it("summarizes run_command exit codes", () => {
    const summary = formatToolSummary("run_command", { command: "npm test" }, "exit code: 0\nAll tests passed");
    expect(summary).toContain("exit 0");
  });

  it("summarizes search matches", () => {
    const summary = formatToolSummary("grep_search", { query: "Session" }, "file.ts:1: Session\nfile.ts:2: Session");
    expect(summary).toBe("2 matches");
  });

  it("renders a two-line ⏺/⎿ tool card", async () => {
    const { stripAnsi } = await import("../src/cli/ui/reporter.js");
    const card = renderToolCard("read_file", { path: "src/cli/repl.ts" }, "line1\nline2\nline3", true, 120);
    const lines = card.split("\n");
    expect(lines).toHaveLength(2);
    expect(stripAnsi(lines[0])).toBe("⏺ Read(src/cli/repl.ts)");
    expect(stripAnsi(lines[1])).toContain("⎿ 3 lines (120ms)");
  });

  it("appends dim output preview lines to Bash cards", async () => {
    const { stripAnsi } = await import("../src/cli/ui/reporter.js");
    const card = renderToolCard(
      "run_command",
      { command: "npm test" },
      "vitest: 194 passed\n Done in 6s\nline3\nexit code: 0",
      true,
      3200,
    );
    const lines = card.split("\n");
    expect(lines).toHaveLength(4); // header + ⎿ + 2 preview lines
    expect(stripAnsi(lines[0])).toBe("⏺ Bash(npm test)");
    expect(stripAnsi(lines[1])).toContain("exit 0");
    expect(stripAnsi(lines[2])).toContain("vitest: 194 passed");
    expect(stripAnsi(lines[3])).toContain("Done in 6s");
  });

  it("renders failed tool cards with a red ✗ result", async () => {
    const { stripAnsi } = await import("../src/cli/ui/reporter.js");
    const card = renderToolCard("run_command", { command: "boom" }, "exit code: 1", false, 50);
    const lines = card.split("\n");
    expect(stripAnsi(lines[0])).toBe("⏺ Bash(boom)");
    expect(stripAnsi(lines[1])).toContain("⎿ ✗ exit 1");
  });
});

describe("Welcome banner tips", () => {
  it("picks unique tips from the pool", () => {
    const tips = pickWelcomeTips(["a", "b", "c", "d"], 3);
    expect(tips).toHaveLength(3);
    expect(new Set(tips).size).toBe(3);
    for (const t of tips) expect(["a", "b", "c", "d"]).toContain(t);
  });
});

describe("UI Reporter Lifecycle & Formatting", () => {
  it("formats OpenCode-style collapsed and expanded thought badges", () => {
    const collapsed = formatThoughtLine(315);
    expect(collapsed).toContain("+ Thought: 315ms");

    const expanded = formatThoughtLine(315, true, "Checking authentication");
    expect(expanded).toContain("- Thought: 315ms");
    expect(expanded).toContain("Checking authentication");
  });

  it("points the thought hint at Ctrl+O (Ctrl+T toggles the task view)", () => {
    expect(formatThoughtLine(315)).toContain("Ctrl+O or /t to view");
    expect(formatThoughtLine(315, true, "text")).toContain("Ctrl+O or /t to collapse");
    expect(formatThoughtLine(315)).not.toContain("Ctrl+T");
  });

  it("renders the compact one-line task summary for collapsed view", () => {
    const summary = renderCompactTodoSummary([
      { id: "1", content: "Inspect codebase", status: "completed" },
      { id: "2", content: "Implement feature", status: "in_progress" },
      { id: "3", content: "Run tests", status: "pending" },
    ]);
    expect(summary).toContain("3 tasks");
    expect(summary).toContain("1 done");
    expect(summary).toContain("1 in progress");
    expect(summary).toContain("1 open");
    // The compact view must not render the full per-task checklist.
    expect(summary).not.toContain("Inspect codebase");
  });

  it("renderTodoList supports the compact/expanded contract", () => {
    const list = [
      { id: "1", content: "A", status: "completed" as const },
      { id: "2", content: "B", status: "pending" as const },
    ];
    expect(renderTodoList([])).toBe("");
    expect(renderTodoList(list)).toContain("A");
  });

  it("ConsoleAgentReporter manages thinking lifecycle without throwing", () => {
    const reporter = new ConsoleAgentReporter();
    expect(() => {
      reporter.onIterationStart(1, 5, "explore");
      reporter.onThinking("Planning the next step", 315);
      reporter.onToolStart("view_file", { path: "src/index.ts" });
      reporter.onToolComplete("view_file", { path: "src/index.ts" }, "file content", true, 120);
      reporter.stop();
    }).not.toThrow();
  });

  it("strips ANSI escape sequences cleanly", async () => {
    const { stripAnsi } = await import("../src/cli/ui/reporter.js");
    const colored = "\x1b[31mError\x1b[0m: \x1b[1mCritical\x1b[22m";
    expect(stripAnsi(colored)).toBe("Error: Critical");
  });

  it("calculates terminal line counts and text wrapping accurately", async () => {
    const { countTerminalLines } = await import("../src/cli/ui/reporter.js");
    expect(countTerminalLines("Line 1\nLine 2", 80)).toBe(2);
    // Line wrapping on 40-col terminal
    const longLine = "a".repeat(85);
    expect(countTerminalLines(longLine, 40)).toBe(3); // 40 + 40 + 5
  });

  it("counts double-width emoji as two cells when wrapping", async () => {
    const { countTerminalLines } = await import("../src/cli/ui/reporter.js");
    // 50 emoji * 2 cells = 100 cells -> 2 lines at 80 cols (not 1).
    expect(countTerminalLines("📋".repeat(50), 80)).toBe(2);
  });

  it("ConsoleAgentReporter manages sticky footer and todo updates without throwing", () => {
    const reporter = new ConsoleAgentReporter(process.cwd(), false, [
      { id: "1", content: "Inspect codebase", status: "completed" },
    ]);
    expect(() => {
      reporter.onIterationStart(1, 5, "explore");
      reporter.onTodoUpdate([
        { id: "1", content: "Inspect codebase", status: "completed" },
        { id: "2", content: "Implement feature", activeForm: "Implementing feature", status: "in_progress" },
      ]);
      reporter.setTodosExpanded(false);
      reporter.setTodosExpanded(true);
      reporter.onToolStart("edit_file", { path: "src/auth.ts" }, "Implementing feature");
      reporter.onToolComplete("edit_file", { path: "src/auth.ts" }, "ok", true, 50);
      reporter.stop();
    }).not.toThrow();
  });

  it("ConsoleAgentReporter manages suspend, resume, and setIsAutoMode lifecycle cleanly", () => {
    const reporter = new ConsoleAgentReporter();
    expect(() => {
      reporter.onIterationStart(1, 5, "implement");
      reporter.setIsAutoMode(true);
      reporter.suspend();
      reporter.resume();
      reporter.setIsAutoMode(false);
      reporter.stop();
    }).not.toThrow();
  });
});
