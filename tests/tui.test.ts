import { describe, expect, it, vi, afterEach } from "vitest";
import { TuiState, safeText } from "../src/cli/tui/state.js";
import { renderFrame, wrap, graphemes } from "../src/cli/tui/view.js";
import { InputEditor } from "../src/cli/tui/terminal.js";
import { shouldUseTui } from "../src/runtime/cli.js";
import { stringWidth } from "../src/cli/ui/theme.js";
import type { CliArgs } from "../src/index.js";
import type { RuntimeEvent } from "../src/runtime/contracts.js";
const args = { repo: "/tmp/project", task: "", maxIterations: 10 } as CliArgs;
const event = (type: string, data: Record<string, unknown> = {}, agentId = "coordinator", correlationId = "call") =>
  ({ type, data, agentId, correlationId, runId: "run" } as RuntimeEvent);
const state = () => new TuiState("/project", "test-model", "Session approval policy");
afterEach(() => vi.unstubAllEnvs());
describe("interactive terminal state", () => {
  it("merges streaming, persisted messages and terminal warnings without duplicate answers", () => {
    const s = state();
    [event("runtime_origin"), event("message", { message: { kind: "text", role: "user", text: "Fix the bug" } }),
      event("model_start", { turn: 1 }), event("text_delta", { text: "Fixed " }), event("text_delta", { text: "it." }),
      event("message", { message: { kind: "text", role: "assistant", text: "Fixed it." } }),
      event("done", { finalMessage: "Fixed it.\nRequired check still pending", status: "blocked" })].forEach(e => s.apply(e));
    expect(s.entries).toEqual([{ kind: "user", text: "Fix the bug" }, { kind: "assistant", text: "Fixed it.\nRequired check still pending" }]);
    expect(s.status).toBe("blocked");
    s.apply(event("runtime_origin")); s.apply(event("done", { finalMessage: "Next answer", status: "completed" }));
    expect(s.entries.filter(e => e.kind === "assistant")).toHaveLength(2);
  });
  it("keeps intermediate responses and excludes worker text from the coordinator answer", () => {
    const s = state();
    s.apply(event("text_delta", { text: "Inspecting" }));
    s.apply(event("model_start", {}, "child"));
    s.apply(event("text_delta", { text: "private worker text" }, "child"));
    s.apply(event("done", { finalMessage: "worker result", status: "completed" }, "child"));
    s.apply(event("model_start", { role: "compaction" }));
    s.apply(event("message", { message: { kind: "text", role: "assistant", text: "Inspecting" } }));
    s.apply(event("model_start", { turn: 2 }));
    s.apply(event("done", { finalMessage: "Done", status: "completed" }));
    expect(s.entries.map(e => e.text)).toEqual(["Inspecting", "Done"]);
  });
  it("correlates tool results and pending replies exactly", () => {
    const s = state();
    s.apply(event("tool_intent", { name: "run_command", args: { command: "npm test" } }));
    s.apply(event("tool_result", { ok: true, output: "all passed", ms: 20 }, "coordinator", "other"));
    expect(s.entries[0].status).toBe("running");
    s.apply(event("tool_result", { ok: false, output: "failure", ms: 20 }));
    expect(s.entries[0]).toMatchObject({ status: "failed", detail: "failure" });
    s.apply(event("tool_intent", { name: "read_file", args: { path: "worker.ts" } }, "child"));
    s.apply(event("tool_result", { ok: true, output: "coordinator result", ms: 21 }));
    expect(s.entries[1].status).toBe("running");
    s.apply(event("tool_result", { ok: true, output: "worker result", ms: 22 }, "child"));
    expect(s.entries[1]).toMatchObject({ status: "done", detail: "worker result" });
    s.apply(event("approval_request", { id: "a", prompt: "Run npm test?" }));
    s.apply(event("input_request", { id: "b", prompt: "Which file?" }));
    s.apply(event("approval_response", { id: "stale" })); expect(s.pending.size).toBe(2);
    s.apply(event("approval_response", { id: "a" })); expect([...s.pending.keys()]).toEqual(["b"]);
    expect(s.view).toBe("Activity");
  });
  it("renders tasks, workers, checks and unknown pricing from events", () => {
    const s = state();
    s.apply(event("worker_started", { id: "worker", role: "coding" }));
    s.apply(event("worker_integrated", { id: "worker" }));
    s.apply(event("tasks", { tasks: [{ objective: "Fix auth", status: "completed", acceptance: ["denies invalid tokens"], dependencies: [], owner: "worker" }] }));
    s.apply(event("verification", { record: { id: "check", command: "npm test", exitCode: 0, valid: false } }));
    s.apply(event("usage", { input: 120, output: 20, cachedInput: 40, costUsd: null }));
    s.view = "Tasks";
    const text = renderFrame(s, "", 0, 100, 30, false).lines.join("\n");
    expect(text).toContain("Fix auth"); expect(text).toContain("npm test · stale"); expect(text).toContain("cost unknown");
    s.view = "Agents"; expect(renderFrame(s, "", 0, 100, 30, false).lines.join("\n")).toContain("coding · integrated");
  });
  it("bounds transcript and tool output while stripping terminal commands", () => {
    const s = state();
    for (let n = 0; n < 600; n++) s.notice(String(n));
    expect(s.entries).toHaveLength(500);
    s.apply(event("text_delta", { text: "x".repeat(100000) }));
    expect(s.entries.at(-1)!.text.length).toBeLessThan(64000);
    const malicious = "hello\x1b[2J\x1b]52;c;Y2xpcA==\x07\u202eevil";
    expect(safeText(malicious)).toBe("helloevil");
    s.notice(malicious);
    expect(renderFrame(s, "", 0, 80, 24, false).lines.join("\n")).not.toContain("\x1b");
  });
});
describe("terminal layout and editor", () => {
  it.each([[30, 18], [80, 24], [120, 40]])("fits %i×%i with multiline input and approval", (columns, rows) => {
    const s = state(); s.apply(event("approval_request", { id: "a", prompt: "Run command? ".repeat(30) }));
    const input = "some code\n".repeat(8) + "界";
    const frame = renderFrame(s, input, graphemes(input).length, columns, rows, false);
    expect(frame.lines).toHaveLength(rows);
    expect(frame.lines.every(line => stringWidth(line) <= columns - 2)).toBe(true);
    expect(frame.cursorRow).toBeLessThanOrEqual(rows); expect(frame.cursorColumn).toBeLessThanOrEqual(columns);
    expect(frame.lines.join("\n")).toContain("APPROVAL REQUIRED");
  });
  it("keeps the selected session visible in a long list", () => {
    const s = state(); s.view = "Sessions";
    s.sessions = Array.from({ length: 100 }, (_, i) => ({ id: `session-${i}`, status: "completed", repoRoot: `/repo-${i}` }));
    for (const index of [0, 50, 99]) {
      s.selectedSession = index;
      expect(renderFrame(s, "", 0, 100, 24, false).lines.join("\n")).toContain(`› session- · completed · /repo-${index}`);
    }
  });
  it("wraps wide characters, preserves Markdown code and handles narrow terminals", () => {
    expect(wrap("界界界", 4)).toEqual(["界界", "界"]);
    const s = state(); s.add({ kind: "assistant", text: "# Result\n**Fixed**\n```ts\nconst ok = true;\n```" });
    const text = renderFrame(s, "", 0, 80, 24, false).lines.join("\n");
    expect(text).toContain("│ const ok = true;"); expect(text).not.toContain("**");
    expect(renderFrame(s, "", 0, 20, 5, false).lines[0]).toContain("Enlarge terminal");
  });
  it("edits grapheme clusters and restores drafts after input history", () => {
    const e = new InputEditor(); e.insert("a👩‍💻界");
    e.key({ name: "left" }); e.key({ name: "backspace" }); expect(e.value).toBe("a界");
    e.remember(); e.insert("draft"); e.key({ name: "up" }); expect(e.value).toBe("a界");
    e.key({ name: "down" }); expect(e.value).toBe("draft");
    e.insert("\nnext word"); e.key({ ctrl: true, name: "w" }); expect(e.value).toBe("draft\nnext ");
    e.key({ ctrl: true, name: "u" }); expect(e.value).toBe("");
    e.insert("z".repeat(40000)); expect(e.value).toHaveLength(32000);
  });
  it("uses TUI only for interactive text clients", () => {
    vi.stubEnv("TERM", "xterm-256color");
    expect(shouldUseTui(args, [], true, true)).toBe(true);
    for (const overrides of [{ ui: "legacy" }, { printMode: true }, { outputFormat: "json" }, { outputFormat: "stream-json" }])
      expect(shouldUseTui({ ...args, ...overrides } as CliArgs, [], true, true)).toBe(false);
    expect(shouldUseTui(args, ["--detach"], true, true)).toBe(false);
    expect(shouldUseTui(args, [], false, true)).toBe(false);
    expect(shouldUseTui(args, [], true, false)).toBe(false);
    vi.stubEnv("TERM", "dumb"); expect(shouldUseTui(args, [], true, true)).toBe(false);
  });
});
