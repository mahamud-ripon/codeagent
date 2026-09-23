import { describe, expect, it } from "vitest";
import {
  badge,
  formatDuration,
  formatPath,
  formatMarkdown,
  formatDiff,
  formatToolSummary,
  formatUserMessage,
  formatThinking,
  formatThoughtLine,
  ConsoleAgentReporter,
  toolIcon,
} from "../src/cli/ui/index.js";

describe("UI Theme & Helpers", () => {
  it("formats durations accurately", () => {
    expect(formatDuration(450)).toBe("450ms");
    expect(formatDuration(1200)).toBe("1.2s");
    expect(formatDuration(2560)).toBe("2.6s");
  });

  it("creates semantic badges", () => {
    const b = badge("Ready", "success");
    expect(b).toContain("Ready");
  });

  it("formats relative paths", () => {
    const formatted = formatPath("D:/Codeagent/src/index.ts", "D:/Codeagent");
    expect(formatted).toBe("src\\index.ts".replace("/", "\\"));
  });

  it("formats user prompt as a full-width background bar", () => {
    const bar = formatUserMessage("hello", 60);
    expect(bar).toContain("hello");
    expect(bar).toContain(" > ");
    // Verify ANSI background codes are present
    expect(bar).toContain("\x1b[48;2;45;49;58m");
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

  it("formats unified diffs with color tokens", () => {
    const diff = "--- a/file.ts\n+++ b/file.ts\n@@ -1,3 +1,3 @@\n-const a = 1;\n+const a = 2;";
    const formatted = formatDiff(diff);
    expect(formatted).toContain("-const a = 1;");
    expect(formatted).toContain("+const a = 2;");
  });
});

describe("UI Reporter Tool Summaries", () => {
  it("summarizes run_command exit codes", () => {
    const summary = formatToolSummary("run_command", { command: "npm test" }, "exit code: 0\nAll tests passed");
    expect(summary).toContain("npm test");
    expect(summary).toContain("exit 0");
  });

  it("summarizes search matches", () => {
    const summary = formatToolSummary("grep_search", { query: "Session" }, "file.ts:1: Session\nfile.ts:2: Session");
    expect(summary).toContain('"Session"');
    expect(summary).toContain("2 matches");
  });

  it("resolves tool icons", () => {
    expect(toolIcon("run_command")).toBe("💻");
    expect(toolIcon("grep_search")).toBe("🔍");
    expect(toolIcon("view_file")).toBe("📄");
    expect(toolIcon("edit_file")).toBe("📝");
  });

  it("formats thinking text with gutter and header", () => {
    const thinking = formatThinking("Inspect src/auth.ts\nCheck password validity");
    expect(thinking).toContain("Thinking:");
    expect(thinking).toContain("Inspect src/auth.ts");
    expect(thinking).toContain("Check password validity");
    expect(thinking).toContain("│");
  });

  it("formats OpenCode-style collapsed and expanded thought badges", () => {
    const collapsed = formatThoughtLine(315);
    expect(collapsed).toContain("+ Thought: 315ms");

    const expanded = formatThoughtLine(315, true, "Checking authentication");
    expect(expanded).toContain("- Thought: 315ms");
    expect(expanded).toContain("Checking authentication");
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
});
