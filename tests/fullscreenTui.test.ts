import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cellWidth,
  EditorBuffer,
  TerminalScreen,
  terminalText,
  wrapText,
} from "../src/tui/screen.js";

class FakeInput extends PassThrough {
  isTTY = true;
  isRaw = false;
  setRawMode = vi.fn((enabled: boolean) => {
    this.isRaw = enabled;
    return this;
  });
}

class FakeOutput extends PassThrough {
  isTTY = true;
  columns = 100;
  rows = 30;
  chunks: string[] = [];

  constructor() {
    super();
    this.on("data", (chunk: Buffer) => this.chunks.push(chunk.toString()));
  }
}

const screens: TerminalScreen[] = [];
function terminal(
  options: { raw?: boolean; columns?: number; rows?: number } = {},
) {
  const input = new FakeInput();
  input.pause();
  input.isRaw = options.raw ?? false;
  const output = new FakeOutput();
  output.columns = options.columns ?? 100;
  output.rows = options.rows ?? 30;
  const callbacks = {
    onSubmit: vi.fn(),
    onCancel: vi.fn(),
    onExit: vi.fn(),
    onCycleMode: vi.fn(),
  };
  const screen = new TerminalScreen({
    ...callbacks,
    input: input as unknown as NodeJS.ReadStream,
    output: output as unknown as NodeJS.WriteStream,
  });
  screens.push(screen);
  screen.start();
  return {
    screen,
    input,
    output,
    ...callbacks,
    type: (text: string | Buffer) => input.emit("data", text),
    text: () => screen.frame().lines.join("\n"),
  };
}

function expectFits(screen: TerminalScreen, columns: number, rows: number) {
  const frame = screen.frame(columns, rows);
  expect(frame.lines.length).toBeLessThanOrEqual(rows);
  for (const line of frame.lines) expect(cellWidth(line)).toBeLessThan(columns);
  expect(frame.cursorRow).toBeGreaterThanOrEqual(1);
  expect(frame.cursorRow).toBeLessThanOrEqual(rows);
  expect(frame.cursorColumn).toBeGreaterThanOrEqual(1);
  expect(frame.cursorColumn).toBeLessThan(columns);
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const screen of screens.splice(0)) screen.stop();
  vi.useRealTimers();
});

describe("terminal text and editing", () => {
  it("renders tool escape sequences as text without terminal control effects", () => {
    const unsafe =
      "\x1b[2Jhello\x1b[31m red\x1b[0m\x1b]52;c;c2VjcmV0\x07\r\nnext\tcolumn\x00\x07";
    expect(terminalText(unsafe)).toBe("hello red\nnext    column");
    expect(
      terminalText("\x1b]8;;https://example.com\x07link\x1b]8;;\x07"),
    ).toBe("link");
  });

  it("wraps by terminal cells without splitting graphemes", () => {
    expect(cellWidth("界e\u0301👩‍💻🇧🇩")).toBe(7);
    expect(wrapText("界e\u0301👩‍💻🇧🇩", 3)).toEqual(["界e\u0301", "👩‍💻", "🇧🇩"]);
    expect(wrapText("a\nb\n", 2)).toEqual(["a", "b", ""]);
    expect(wrapText("界a", 1)).toEqual(["a"]);
  });

  it("moves and deletes whole combining and emoji graphemes", () => {
    const editor = new EditorBuffer();
    editor.insert("Ae\u0301👩‍💻Z");
    editor.left();
    editor.backspace();
    expect(editor.text).toBe("Ae\u0301Z");
    editor.left();
    editor.delete();
    expect(editor.text).toBe("AZ");
    editor.right();
    editor.insert("!");
    expect(editor.text).toBe("AZ!");
  });

  it("keeps home/end within the current line", () => {
    const editor = new EditorBuffer();
    editor.set("first\nsecond");
    editor.home();
    editor.insert("new ");
    editor.end();
    editor.insert("!");
    expect(editor.text).toBe("first\nnew second!");
  });
});

describe("full-screen terminal behavior", () => {
  it("pauses initially untouched stdin on exit so Node can terminate", () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    expect(input.readableFlowing).toBeNull();
    expect(input.isPaused()).toBe(false);
    const screen = new TerminalScreen({
      input: input as unknown as NodeJS.ReadStream,
      output: output as unknown as NodeJS.WriteStream,
      onSubmit: () => {},
      onCancel: () => {},
      onExit: () => {},
      onCycleMode: () => {},
    });
    screens.push(screen);
    screen.start();
    screen.stop();
    expect(input.isPaused()).toBe(true);
    expect(input.isRaw).toBe(false);
  });

  it("bounds frames and the editor cursor at narrow, wide, and short sizes", () => {
    const { screen } = terminal();
    screen.add("assistant", "界👩‍💻 a long streamed answer ".repeat(100));
    screen.editor.set("a multiline prompt\n".repeat(8) + "界👩‍💻".repeat(80));
    for (const [columns, rows] of [
      [2, 1],
      [12, 4],
      [24, 10],
      [40, 12],
      [100, 30],
      [180, 50],
    ]) {
      expectFits(screen, columns, rows);
    }
    expect(screen.frame(12, 4).cursorVisible).toBe(false);
  });

  it("redraws on resize using the new terminal dimensions", () => {
    const { screen, output } = terminal();
    screen.editor.set("describe the changes ".repeat(12));
    output.chunks.length = 0;
    output.columns = 32;
    output.rows = 12;
    output.emit("resize");
    vi.advanceTimersByTime(33);
    expect(output.chunks).toHaveLength(1);
    const rendered = stripVTControlCharacters(output.chunks[0]).split("\r\n");
    expect(rendered.length).toBeLessThanOrEqual(12);
    rendered.forEach((line) => expect(cellWidth(line)).toBeLessThan(32));
    expectFits(screen, 32, 12);
  });

  it("coalesces streaming redraws and displays the final answer once", () => {
    const { screen, output, text } = terminal();
    output.chunks.length = 0;
    screen.add("user", "say hello");
    screen.handleEvent({ type: "text_delta", text: "Hello " });
    screen.handleEvent({ type: "text_delta", text: "world" });
    expect(output.chunks).toHaveLength(0);
    vi.advanceTimersByTime(33);
    expect(output.chunks).toHaveLength(1);
    screen.finish("Hello world", 1200);
    expect(text().match(/Hello world/g)).toHaveLength(1);
    expect(text()).toContain("Finished in 1.2s");
    screen.add("user", "again");
    screen.finish("Non-streaming answer", 100);
    expect(text()).toContain("Non-streaming answer");
  });

  it("keeps interleaved same-name tools associated with their call IDs", () => {
    const { screen, text } = terminal({ rows: 45 });
    screen.handleEvent({
      type: "tool_start",
      id: "one",
      name: "read_file",
      args: { path: "first.ts" },
    });
    screen.handleEvent({
      type: "tool_start",
      id: "two",
      name: "read_file",
      args: { path: "second.ts" },
    });
    screen.handleEvent({
      type: "tool_output_delta",
      id: "two",
      chunk: "second live",
    });
    screen.handleEvent({
      type: "tool_output_delta",
      id: "one",
      chunk: "first live",
    });
    expect(text()).toMatch(/first\.ts \[running\]\nfirst live/);
    expect(text()).toMatch(/second\.ts \[running\]\nsecond live/);
    screen.handleEvent({
      type: "tool_end",
      id: "two",
      ok: false,
      output: "second failed",
      ms: 200,
    });
    screen.handleEvent({
      type: "tool_end",
      id: "one",
      ok: true,
      output: "first finished",
      ms: 100,
    });
    expect(text()).toMatch(/first\.ts \[done · 0\.1s\]\nfirst live/);
    expect(text()).toMatch(/second\.ts \[failed · 0\.2s\]\nsecond live/);
    expect(text()).not.toContain("first finished");
  });

  it("counts authoritative usage once and preserves completed tool output tails", () => {
    const { screen, text } = terminal({ columns: 140 });
    screen.handleEvent({ type: "usage", input: 100, output: 20 });
    screen.handleEvent({
      type: "usage",
      input: 100,
      output: 20,
      costUsd: 0.002,
    });
    expect(screen.frame().lines[1]).toContain("tokens:100/20");
    expect(screen.frame().lines[1]).toContain("$0.0020");
    screen.handleEvent({
      type: "tool_start",
      id: "test",
      name: "run_command",
      args: {},
    });
    screen.handleEvent({
      type: "tool_output_delta",
      id: "test",
      chunk: "setup\n".repeat(100) + "FAIL final diagnostic",
    });
    screen.handleEvent({
      type: "tool_end",
      id: "test",
      ok: false,
      output: "setup\n".repeat(80),
      ms: 100,
    });
    expect(text()).toContain("FAIL final diagnostic");
  });

  it("moves vertically through multiline input without loading history", () => {
    const { screen, type } = terminal();
    type("old prompt\r");
    screen.editor.set("first\n👩‍💻z");
    type("\x1b[A");
    type("!");
    expect(screen.editor.text).toBe("fi!rst\n👩‍💻z");
    type("\x1b[B");
    type("?");
    expect(screen.editor.text).toBe("fi!rst\n👩‍💻z?");
  });

  it("submits while busy so the owner can queue prompts, and restores history drafts", () => {
    const { screen, type, onSubmit } = terminal();
    screen.setStatus({ running: true, queued: 2 });
    type("first prompt\r");
    type("second prompt\r");
    expect(onSubmit.mock.calls).toEqual([["first prompt"], ["second prompt"]]);
    expect(screen.editor.text).toBe("");
    type("unfinished");
    type("\x1b[A");
    expect(screen.editor.text).toBe("second prompt");
    type("\x1b[B");
    expect(screen.editor.text).toBe("unfinished");
    expect(screen.frame().lines[1]).toContain("queue:2");
  });

  it("edits Unicode through actual arrow and backspace input", () => {
    const { screen, type } = terminal();
    type("A👩‍💻e\u0301Z");
    type("\x1b[D");
    type("\x7f");
    expect(screen.editor.text).toBe("A👩‍💻Z");
    type("\x1b[D");
    type("\x1b[3~");
    expect(screen.editor.text).toBe("AZ");
    type("\x1b[C");
    type("!");
    expect(screen.editor.text).toBe("AZ!");
  });

  it("pastes multiline UTF-8 text with fragmented markers without submitting", () => {
    const { screen, type, onSubmit } = terminal();
    const bytes = Buffer.from("\x1b[200~first\n界👩‍💻\nlast\x1b[201~");
    // Terminal data chunks may split either the marker or any UTF-8 code point.
    for (const byte of bytes) type(Buffer.from([byte]));
    vi.advanceTimersByTime(600);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.editor.text).toBe("first\n界👩‍💻\nlast");
    type("\r");
    expect(onSubmit).toHaveBeenCalledWith("first\n界👩‍💻\nlast");
  });

  it("keeps a fragmented paste end marker out of the editor", () => {
    const { screen, type } = terminal();
    type("\x1b[200~hello\nworld\x1b");
    type("[201~");
    expect(screen.editor.text).toBe("hello\nworld");
  });

  it("defaults permission dialogs to deny and preserves the draft", async () => {
    const { screen, type, onSubmit } = terminal();
    type("my draft");
    const decision = screen.confirm("Run command?", "rm -rf generated");
    expect(screen.frame().cursorVisible).toBe(false);
    type("\r");
    await expect(decision).resolves.toBe(false);
    expect(screen.editor.text).toBe("my draft");
    expect(onSubmit).not.toHaveBeenCalled();
    const allowed = screen.confirm("Run tests?", "npm test");
    type("y");
    await expect(allowed).resolves.toBe(true);
  });

  it("never treats pasted y as permission approval, even with fragmented markers", async () => {
    const { screen, type } = terminal();
    let settled = false;
    const decision = screen.confirm("Allow?", "Run a command");
    void decision.then(() => {
      settled = true;
    });
    for (const character of "\x1b[200~y\n\x1b[201~") type(character);
    vi.advanceTimersByTime(600);
    await Promise.resolve();
    expect(settled).toBe(false);
    type("n");
    await expect(decision).resolves.toBe(false);
    expect(screen.editor.text).toBe("");
  });

  it("cancels a running turn and settles its permission prompt on Ctrl+C", async () => {
    const { screen, type, onCancel, onExit } = terminal();
    screen.setStatus({ running: true });
    const decision = screen.confirm("Allow?", "Run a command");
    type("\x03");
    await expect(decision).resolves.toBe(false);
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onExit).not.toHaveBeenCalled();
  });

  it("handles standalone Escape as cancellation after the key ambiguity timeout", () => {
    const { screen, type, onCancel } = terminal();
    screen.setStatus({ running: true });
    type("\x1b");
    vi.advanceTimersByTime(600);
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    "restores original raw mode %s, listeners, and pending decisions on stop",
    async (raw) => {
      const exitListeners = process.listenerCount("exit");
      const { screen, input, output, type, onSubmit } = terminal({ raw });
      const decision = screen.confirm("Allow?", "Run a command");
      expect(input.isRaw).toBe(true);
      expect(process.listenerCount("exit")).toBe(exitListeners + 1);
      screen.stop();
      screen.stop();
      await expect(decision).resolves.toBe(false);
      expect(input.isRaw).toBe(raw);
      expect(input.isPaused()).toBe(true);
      expect(input.listenerCount("data")).toBe(0);
      expect(input.listenerCount("end")).toBe(0);
      expect(output.listenerCount("resize")).toBe(0);
      expect(process.listenerCount("exit")).toBe(exitListeners);
      expect(output.chunks.join("")).toContain(
        "\x1b[?2004l\x1b[?25h\x1b[?1049l",
      );
      const writes = output.chunks.length;
      vi.advanceTimersByTime(2000);
      type("ignored\r");
      expect(onSubmit).not.toHaveBeenCalled();
      expect(output.chunks).toHaveLength(writes);
    },
  );

  it("scrolls long permission previews while keeping the deny choice visible", async () => {
    const { screen, type, text } = terminal({ columns: 40, rows: 12 });
    const decision = screen.confirm(
      "Allow command?",
      Array.from({ length: 30 }, (_, i) => `command line ${i}`).join("\n"),
    );
    expectFits(screen, 40, 12);
    expect(text()).toContain("command line 0");
    for (let i = 0; i < 15; i++) type("\x1b[B");
    expect(text()).toContain("command line 15");
    expect(text()).toContain("Enter/n/Esc deny");
    expectFits(screen, 40, 12);
    type("n");
    await expect(decision).resolves.toBe(false);
  });

  it("keeps credentials out of prompt history", () => {
    const { screen, type, onSubmit } = terminal();
    type("safe prompt\r");
    type("/key provider example-secret\r");
    expect(onSubmit).toHaveBeenLastCalledWith("/key provider example-secret");
    type("\x1b[A");
    expect(screen.editor.text).toBe("safe prompt");
  });

  it("completes slash commands and cycles modes only while idle", () => {
    const { screen, type, onCycleMode } = terminal();
    type("/sta\t");
    expect(screen.editor.text).toBe("/status ");
    type("\x1b[Z");
    expect(onCycleMode).toHaveBeenCalledOnce();
    screen.setStatus({ running: true });
    type("\x1b[Z");
    expect(onCycleMode).toHaveBeenCalledOnce();
  });

  it("shows hidden reasoning only when explicitly expanded", () => {
    const { screen, type, text } = terminal();
    screen.handleEvent({ type: "thinking_delta", text: "reasoning detail" });
    expect(text()).not.toContain("reasoning detail");
    type("\x0f");
    expect(text()).toContain("reasoning detail");
    type("\x0f");
    expect(text()).not.toContain("reasoning detail");
  });

  it("keeps pre-existing stream listeners when relinquishing the terminal", () => {
    const { screen, input, output } = terminal();
    const inputListener = vi.fn();
    const resizeListener = vi.fn();
    input.on("data", inputListener);
    output.on("resize", resizeListener);
    screen.stop();
    input.emit("data", "x");
    output.emit("resize");
    expect(inputListener).toHaveBeenCalledWith("x");
    expect(resizeListener).toHaveBeenCalledOnce();
  });

  it("answers an agent question without dispatching a command or losing the draft cursor", async () => {
    const { screen, type, onSubmit } = terminal();
    type("my draft");
    type("\x1b[D");
    const cursor = screen.editor.cursor;
    const answer = screen.ask("Which directory?");
    expect(screen.frame().lines.join("\n")).toContain(
      "QUESTION: Which directory?",
    );
    expect(screen.editor.text).toBe("");
    type("/src\r");
    await expect(answer).resolves.toBe("/src");
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.editor.text).toBe("my draft");
    expect(screen.editor.cursor).toBe(cursor);
  });

  it("cancels a running question on Ctrl+C and restores the draft", async () => {
    const { screen, type, onCancel } = terminal();
    screen.setStatus({ running: true });
    type("pending prompt");
    const answer = screen.ask("Continue?");
    type("\x03");
    await expect(answer).resolves.toMatch(/cancelled/i);
    expect(onCancel).toHaveBeenCalledOnce();
    expect(screen.editor.text).toBe("pending prompt");
  });

  it("settles agent questions and restores the draft when stopped", async () => {
    const { screen, type } = terminal();
    type("pending prompt");
    const answer = screen.ask("Continue?");
    type("partial answer");
    screen.stop();
    await expect(answer).resolves.toMatch(/cancelled/i);
    expect(screen.editor.text).toBe("pending prompt");
  });

  it("settles pending permissions when input ends", async () => {
    const { screen, input, onExit } = terminal();
    const decision = screen.confirm("Allow?", "Run a command");
    input.emit("end");
    await expect(decision).resolves.toBe(false);
    expect(onExit).toHaveBeenCalledOnce();
  });
});
