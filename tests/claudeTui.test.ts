import { describe, expect, it } from "vitest";
import {
  ACTION_VERBS,
  CLAUDE_TIPS,
  formatClaudeToolHierarchy,
  formatThinkingRollup,
  formatTurnCompletionLine,
  renderJumpToBottomBadge,
  renderStatusDock,
} from "../src/cli/ui/index.js";
import {
  discoverRules,
  formatLoadedRuleLine,
  formatRulesForContext,
} from "../src/agent/rules.js";
import { stripAnsi } from "../src/cli/ui/theme.js";
import path from "node:path";
import os from "node:os";

describe("Claude Code TUI — 8 Point Specification", () => {
  // Point 1: Header & Session Branding
  it("Point 1: Header & Banner helpers format correctly", async () => {
    const { renderBanner } = await import("../src/cli/ui/banner.js");
    expect(() => {
      renderBanner({
        repoRoot: process.cwd(),
        model: "nemotron-3-ultra:cloud",
        needsKey: false,
      });
    }).not.toThrow();
  });

  // Point 2: User Input & Turn History
  it("Point 2: Formats user message into charcoal background bar", async () => {
    const { formatUserMessage } = await import("../src/cli/ui/theme.js");
    const bar = formatUserMessage("explore the project", 60);
    expect(stripAnsi(bar)).toContain(" > explore the project");
  });

  // Point 3: Dynamic Action Verbs & Live Stats
  it("Point 3: Contains active cooking/wandering verbs and interactive tips", () => {
    expect(ACTION_VERBS).toContain("Whirring..");
    expect(ACTION_VERBS).toContain("Garnishing..");
    expect(ACTION_VERBS).toContain("Meandering..");
    expect(ACTION_VERBS.length).toBeGreaterThanOrEqual(8);

    expect(CLAUDE_TIPS.some((t) => t.includes("subagents"))).toBe(true);
    expect(CLAUDE_TIPS.some((t) => t.includes("/plan"))).toBe(true);
    expect(CLAUDE_TIPS.some((t) => t.includes("/undo"))).toBe(true);
  });

  // Point 4: Tool Execution Hierarchy (• and L branch)
  it("Point 4: Renders hierarchical tool execution with parent bullet and L branch", () => {
    const readCard = formatClaudeToolHierarchy(
      "read_file",
      { path: "amazon-clone/tsconfig.json" },
      "{}",
      true,
      120,
    );
    const readLines = readCard.split("\n");
    expect(stripAnsi(readLines[0])).toContain("• Reading amazon-clone/tsconfig.json");
    expect(stripAnsi(readLines[1])).toContain("L amazon-clone/tsconfig.json");

    const bashCard = formatClaudeToolHierarchy(
      "run_command",
      { command: "ls -la" },
      "total 0",
      true,
      2400,
    );
    const bashLines = bashCard.split("\n");
    expect(stripAnsi(bashLines[0])).toContain("• Listing files in directory");
    expect(stripAnsi(bashLines[0])).toContain("2.4s");
    expect(stripAnsi(bashLines[1])).toContain("L $ ls -la");
  });

  // Point 5: Multi-Step Monologue & Rule Loading
  it("Point 5: Formats loaded rules with L Loaded prefix and thinking rollup", () => {
    const line = formatLoadedRuleLine("C:\\rules\\coding-style.md");
    expect(stripAnsi(line).trim()).toBe("L Loaded C:\\rules\\coding-style.md");

    const rollup = formatThinkingRollup({
      durationMs: 76000,
      filesRead: 10,
      dirsListed: 14,
      loadedRules: ["C:\\rules\\coding-style.md", "C:\\rules\\hooks.md"],
    });
    const plain = stripAnsi(rollup);
    expect(plain).toContain("Thought for 76.0s, read 10 files, listed 14 directories");
    expect(plain).toContain("L Loaded C:\\rules\\coding-style.md");
    expect(plain).toContain("L Loaded C:\\rules\\hooks.md");
  });

  it("Point 5: Discovers rules when available without throwing", () => {
    const rules = discoverRules(process.cwd());
    expect(Array.isArray(rules)).toBe(true);
    if (rules.length > 0) {
      const contextPrompt = formatRulesForContext(rules);
      expect(contextPrompt).toContain("<project_rules>");
    }
  });

  // Point 6: Response Formatting & Completion Line
  it("Point 6: Renders completion line matching Claude Code (* Cooked for ... / * Worked for ...)", () => {
    const quick = formatTurnCompletionLine(4000, new Date("2026-09-25T22:10:00"));
    expect(stripAnsi(quick)).toMatch(/\* Worked for 4\.0s · done/);

    const longRun = formatTurnCompletionLine(130000, new Date("2026-09-25T22:13:00"));
    expect(stripAnsi(longRun)).toMatch(/\* Cooked for 130\.0s · done/);
  });

  // Point 7: Viewport Scrolling & Floating Badges
  it("Point 7: Renders Jump to bottom badge with Ctrl+End", () => {
    const badge = renderJumpToBottomBadge(80);
    const plain = stripAnsi(badge);
    expect(plain).toContain("Jump to bottom (Ctrl+End) ↓");
  });

  it("Point 7: Reporter attaches floating Jump to bottom badge when output exceeds terminal height", async () => {
    const { ConsoleAgentReporter } = await import("../src/cli/ui/reporter.js");
    const reporter = new ConsoleAgentReporter(process.cwd());
    reporter.startTask();

    // Before overflow, buildFooter contains status dock but no jump badge
    let footer = (reporter as any).buildFooter();
    expect(stripAnsi(footer)).not.toContain("Jump to bottom");

    // Simulate printing more lines than terminal rows (default 24 rows)
    for (let i = 0; i < 30; i++) {
      (reporter as any).printLog(`line ${i}`);
    }

    footer = (reporter as any).buildFooter();
    expect(stripAnsi(footer)).toContain("Jump to bottom (Ctrl+End) ↓");

    // On jump to bottom, the badge is dismissed
    reporter.onJumpToBottom?.();
    footer = (reporter as any).buildFooter();
    expect(stripAnsi(footer)).not.toContain("Jump to bottom");
  });

  // Point 8: Status Dock & Footer Keybindings
  it("Point 8: Renders status dock with mode and shortcuts hints", () => {
    const idleDock = renderStatusDock({ mode: "manual", isRunning: false });
    expect(stripAnsi(idleDock)).toContain("manual mode on");
    expect(stripAnsi(idleDock)).toContain("? for shortcuts");
    expect(stripAnsi(idleDock)).toContain("+ for agents");

    const runningDock = renderStatusDock({ mode: "manual", isRunning: true });
    expect(stripAnsi(runningDock)).toContain("manual mode on");
    expect(stripAnsi(runningDock)).toContain("esc to interrupt");
    expect(stripAnsi(runningDock)).toContain("+ for agents");

    const planDock = renderStatusDock({ mode: "plan", isRunning: false });
    expect(stripAnsi(planDock)).toContain("plan mode on");
  });

  it("Point 5: Rule discovery respects maxRules cap", () => {
    const rules = discoverRules(process.cwd(), undefined, 3);
    expect(rules.length).toBeLessThanOrEqual(3);
  });
});

