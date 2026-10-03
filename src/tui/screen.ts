import readline from "node:readline";
import { PassThrough } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { stripVTControlCharacters } from "node:util";
import type { AgentEvent } from "../llm/events.js";
import { stringWidth } from "../cli/ui/theme.js";

export const TUI_COMMANDS = [
  "help",
  "status",
  "model",
  "mode",
  "plan",
  "diff",
  "undo",
  "sessions",
  "resume",
  "new",
  "export",
  "cost",
  "clear",
  "cancel",
  "exit",
];
const MAX_TEXT = 32_000;
const MAX_ENTRIES = 400;
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const graphemes = (text: string): string[] =>
  Array.from(segmenter.segment(text), (s) => s.segment);

/** Render untrusted model/tool text as data, never terminal instructions. */
export function terminalText(text: string): string {
  return stripVTControlCharacters(text)
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "    ")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}

export function cellWidth(text: string): number {
  return graphemes(text).reduce(
    (sum, g) =>
      sum +
      (/\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(g)
        ? 2
        : stringWidth(g.replace(/\p{Mark}/gu, ""))),
    0,
  );
}

export function wrapText(text: string, width: number): string[] {
  width = Math.max(1, width);
  const lines: string[] = [];
  for (const paragraph of terminalText(text).split("\n")) {
    let line = "";
    let cells = 0;
    for (const g of graphemes(paragraph)) {
      const size = cellWidth(g);
      if (cells + size > width && line) {
        lines.push(line);
        line = "";
        cells = 0;
      }
      // A wide glyph cannot fit in a one-column terminal.
      if (size > width) continue;
      line += g;
      cells += size;
    }
    lines.push(line);
  }
  return lines;
}

function fit(text: string, width: number): string {
  return wrapText(text.replace(/\n/g, " "), width)[0] ?? "";
}

/** Cursor positions are UTF-16 offsets at grapheme boundaries. */
export class EditorBuffer {
  text = "";
  cursor = 0;
  set(text: string): void {
    this.text = text;
    this.cursor = text.length;
  }
  insert(text: string): void {
    text = terminalText(text).slice(
      0,
      Math.max(0, MAX_TEXT - this.text.length),
    );
    this.text =
      this.text.slice(0, this.cursor) + text + this.text.slice(this.cursor);
    this.cursor += text.length;
  }
  left(): void {
    this.cursor =
      [...segmenter.segment(this.text)]
        .map((s) => s.index)
        .filter((i) => i < this.cursor)
        .pop() ?? 0;
  }
  right(): void {
    this.cursor =
      [...segmenter.segment(this.text)]
        .map((s) => s.index)
        .find((i) => i > this.cursor) ?? this.text.length;
  }
  backspace(): void {
    const end = this.cursor;
    this.left();
    this.text = this.text.slice(0, this.cursor) + this.text.slice(end);
  }
  delete(): void {
    const start = this.cursor;
    this.right();
    this.text = this.text.slice(0, start) + this.text.slice(this.cursor);
    this.cursor = start;
  }
  home(): void {
    if (this.cursor === 0) return;
    this.cursor = this.text.lastIndexOf("\n", this.cursor - 1) + 1;
  }
  vertical(direction: -1 | 1): void {
    const lines = this.text.split("\n");
    const before = this.text.slice(0, this.cursor).split("\n");
    const row = before.length - 1;
    const target = row + direction;
    if (target < 0 || target >= lines.length) return;
    const column = graphemes(before[row]).length;
    this.cursor =
      lines.slice(0, target).reduce((n, line) => n + line.length + 1, 0) +
      graphemes(lines[target]).slice(0, column).join("").length;
  }
  end(): void {
    const end = this.text.indexOf("\n", this.cursor);
    this.cursor = end === -1 ? this.text.length : end;
  }
}

type Role = "user" | "assistant" | "system" | "error" | "thinking" | "tool";
interface Entry {
  role: Role;
  text: string;
  title?: string;
  state?: string;
}
export interface ScreenStatus {
  model: string;
  mode: string;
  sandbox: string;
  workspace: string;
  running: boolean;
  queued: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}
interface ScreenOptions {
  onSubmit: (text: string) => void;
  onCancel: () => void;
  onExit: () => void;
  onCycleMode: () => void;
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
}
interface Confirmation {
  title: string;
  body: string;
  resolve: (answer: boolean) => void;
  scroll: number;
}

/** One owner for the alternate screen, raw input, resize, and permission focus. */
export class TerminalScreen {
  readonly editor = new EditorBuffer();
  private entries: Entry[] = [];
  private tools = new Map<string, Entry>();
  private textEntry?: Entry;
  private thinkingEntry?: Entry;
  private streamedText = "";
  private showThinking = false;
  private showTodos = true;
  private todos: string[] = [];
  private scroll = 0;
  private history: string[] = [];
  private historyIndex = 0;
  private historyDraft = "";
  private confirmation?: Confirmation;
  private question?: {
    resolve: (answer: string) => void;
    draft: string;
    cursor: number;
  };
  private status: ScreenStatus = {
    model: "",
    mode: "default",
    sandbox: "local",
    workspace: "",
    running: false,
    queued: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
  };
  private started = false;
  private previousRaw = false;
  private previouslyPaused = true;
  private renderTimer?: ReturnType<typeof setTimeout>;
  private tick?: ReturnType<typeof setInterval>;
  private startedAt = 0;
  private decoder = new StringDecoder("utf8");
  private keyStream = new PassThrough();
  private pendingInput = "";
  private inputTimer?: ReturnType<typeof setTimeout>;
  private lastTranscriptLines = 0;
  private lastWidth = 0;
  private pasting = false;
  private paste = "";
  private readonly input: NodeJS.ReadStream;
  private readonly output: NodeJS.WriteStream;

  constructor(private readonly options: ScreenOptions) {
    this.input = options.input ?? process.stdin;
    this.output = options.output ?? process.stdout;
    readline.emitKeypressEvents(this.keyStream);
    this.keyStream.on("keypress", this.onKey);
  }

  get busy(): boolean {
    return this.status.running;
  }

  start(): void {
    if (this.started) return;
    if (!this.input.isTTY || !this.output.isTTY)
      throw new Error("The full-screen UI requires an interactive terminal.");
    this.previousRaw = !!this.input.isRaw;
    // A fresh stdin has readableFlowing === null (isPaused() is false).
    // Leave it paused unless the caller was already actively consuming input.
    this.previouslyPaused = this.input.readableFlowing !== true;
    this.started = true;
    try {
      this.input.setRawMode(true);
      this.input.on("data", this.onData);
      this.input.on("end", this.onEnd);
      this.output.on("resize", this.scheduleRender);
      process.on("exit", this.stop);
      this.output.write("\x1b[?1049h\x1b[?2004h\x1b[?25l");
      this.input.resume();
      this.tick = setInterval(this.scheduleRender, 1000);
      this.render();
    } catch (error) {
      this.stop();
      throw error;
    }
  }

  stop = (): void => {
    this.cancelConfirmation();
    if (!this.started) return;
    this.started = false;
    clearTimeout(this.renderTimer);
    clearTimeout(this.inputTimer);
    clearInterval(this.tick);
    this.input.removeListener("data", this.onData);
    this.input.removeListener("end", this.onEnd);
    this.output.removeListener("resize", this.scheduleRender);
    process.removeListener("exit", this.stop);
    this.keyStream.removeListener("keypress", this.onKey);
    this.keyStream.destroy();
    try {
      this.output.write("\x1b[0m\x1b[?2004l\x1b[?25h\x1b[?1049l");
    } finally {
      this.input.setRawMode(this.previousRaw);
      if (this.previouslyPaused) this.input.pause();
    }
  };

  private onEnd = (): void => {
    this.cancelConfirmation();
    this.options.onExit();
  };

  setStatus(update: Partial<ScreenStatus>): void {
    if (update.running && !this.status.running) this.startedAt = Date.now();
    if (update.running === false) {
      for (const tool of this.tools.values())
        if (tool.state === "running") tool.state = "stopped";
    }
    this.status = { ...this.status, ...update };
    this.scheduleRender();
  }

  add(role: "user" | "assistant" | "system" | "error", text: string): void {
    if (role === "user") {
      this.streamedText = "";
      this.tools.clear();
      this.textEntry = undefined;
      this.thinkingEntry = undefined;
    }
    this.push({ role, text: text.slice(-MAX_TEXT) });
    this.scheduleRender();
  }

  private push(entry: Entry): void {
    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) this.entries.shift();
  }

  clear(): void {
    this.entries = [];
    this.tools.clear();
    this.textEntry = undefined;
    this.thinkingEntry = undefined;
    this.streamedText = "";
    this.scroll = 0;
    this.scheduleRender();
  }

  handleEvent(event: AgentEvent): void {
    switch (event.type) {
      case "turn_start":
        this.textEntry = undefined;
        this.thinkingEntry = undefined;
        break;
      case "text_delta":
        this.streamedText = (this.streamedText + event.text).slice(-MAX_TEXT);
        if (!this.textEntry) {
          this.textEntry = { role: "assistant", text: "" };
          this.push(this.textEntry);
        }
        this.textEntry.text = (this.textEntry.text + event.text).slice(
          -MAX_TEXT,
        );
        break;
      case "thinking_delta":
        if (!this.thinkingEntry) {
          this.thinkingEntry = { role: "thinking", text: "" };
          this.push(this.thinkingEntry);
        }
        this.thinkingEntry.text = (this.thinkingEntry.text + event.text).slice(
          -MAX_TEXT,
        );
        break;
      case "tool_start": {
        this.textEntry = undefined;
        const args =
          event.args && typeof event.args === "object"
            ? (event.args as Record<string, unknown>)
            : {};
        const target = args.path ?? args.command ?? args.query ?? "";
        const entry: Entry = {
          role: "tool",
          title: `${event.name} ${String(target).slice(0, 500)}`,
          text: "",
          state: "running",
        };
        this.push(entry);
        this.tools.set(event.id, entry);
        break;
      }
      case "tool_output_delta": {
        const tool = this.tools.get(event.id);
        if (tool) tool.text = (tool.text + event.chunk).slice(-MAX_TEXT);
        break;
      }
      case "tool_end": {
        const tool = this.tools.get(event.id);
        if (tool) {
          if (!tool.text) tool.text = event.output.slice(-MAX_TEXT);
          tool.state = `${event.ok ? "done" : "failed"} · ${(event.ms / 1000).toFixed(1)}s`;
        }
        break;
      }
      case "todo_update":
        this.todos = event.todos.slice(0, 20).map((t) => {
          const todo = t as { content?: string; status?: string };
          return `${todo.status === "completed" ? "[x]" : todo.status === "in_progress" ? "[>]" : "[ ]"} ${todo.content ?? ""}`;
        });
        break;
      case "usage":
        // Provider usage is provisional; Agent.run emits the authoritative
        // per-call usage again with cost (including zero for unpriced models).
        if (event.costUsd === undefined) break;
        this.status.inputTokens += event.input;
        this.status.outputTokens += event.output;
        this.status.costUsd += event.costUsd ?? 0;
        break;
      case "error":
        this.push({ role: "error", text: event.message });
        break;
      case "compaction":
        this.push({
          role: "system",
          text: `Context compacted: ${event.before} → ${event.after}`,
        });
        break;
    }
    this.scheduleRender();
  }

  finish(finalMessage: string, durationMs: number): void {
    // Streaming providers already delivered the answer; non-streaming and
    // early-return paths still need a final message.
    if (
      finalMessage.trim() &&
      !this.streamedText.trimEnd().endsWith(finalMessage.trim())
    )
      this.add("assistant", finalMessage);
    for (const tool of this.tools.values())
      if (tool.state === "running") tool.state = "stopped";
    this.add("system", `Finished in ${(durationMs / 1000).toFixed(1)}s`);
  }

  confirm(title: string, body: string): Promise<boolean> {
    if (!this.started || this.confirmation) return Promise.resolve(false);
    return new Promise((resolve) => {
      this.confirmation = { title, body, resolve, scroll: 0 };
      this.scheduleRender();
    });
  }

  ask(question: string): Promise<string> {
    if (!this.started || this.confirmation || this.question)
      return Promise.resolve("Question unavailable; ask again later.");
    this.add("system", `QUESTION: ${question}`);
    return new Promise((resolve) => {
      this.question = {
        resolve,
        draft: this.editor.text,
        cursor: this.editor.cursor,
      };
      this.editor.set("");
      this.scroll = 0;
      this.scheduleRender();
    });
  }

  cancelConfirmation(): void {
    this.resolveConfirmation(false);
    this.resolveQuestion("User cancelled the question.");
  }

  private resolveQuestion(answer: string): void {
    const pending = this.question;
    this.question = undefined;
    if (pending) {
      this.editor.set(pending.draft);
      this.editor.cursor = pending.cursor;
      pending.resolve(answer);
    }
    this.scheduleRender();
  }

  private resolveConfirmation(answer: boolean): void {
    const pending = this.confirmation;
    this.confirmation = undefined;
    pending?.resolve(answer);
    this.scheduleRender();
  }

  /** Bracketed paste may arrive across any number of UTF-8/data chunks. */
  private onData = (data: Buffer | string): void => {
    clearTimeout(this.inputTimer);
    this.pendingInput +=
      typeof data === "string" ? data : this.decoder.write(data);
    const start = "\x1b[200~";
    const end = "\x1b[201~";
    while (this.pendingInput) {
      const marker = this.pasting ? end : start;
      const at = this.pendingInput.indexOf(marker);
      if (at >= 0) {
        const prefix = this.pendingInput.slice(0, at);
        this.pendingInput = this.pendingInput.slice(at + marker.length);
        if (this.pasting) {
          this.paste = (this.paste + prefix).slice(0, MAX_TEXT);
          // Pasted "y" can never approve a pending permission dialog.
          if (!this.confirmation) this.editor.insert(this.paste);
          this.paste = "";
          this.pasting = false;
          this.scheduleRender();
        } else {
          this.keyStream.write(prefix);
          this.pasting = true;
        }
        continue;
      }
      // Hold only a partial bracketed-paste marker. A lone Escape must
      // reach the key decoder promptly for cancellation (short timeout).
      let held = 0;
      for (let n = 1; n < marker.length; n++)
        if (this.pendingInput.endsWith(marker.slice(0, n))) held = n;
      const ready = this.pendingInput.slice(0, this.pendingInput.length - held);
      this.pendingInput = held ? this.pendingInput.slice(-held) : "";
      if (this.pasting) this.paste = (this.paste + ready).slice(0, MAX_TEXT);
      else this.keyStream.write(ready);
      if (held && !this.pasting) {
        this.inputTimer = setTimeout(() => {
          const pending = this.pendingInput;
          this.pendingInput = "";
          if (pending === "\x1b") this.onKey(undefined, { name: "escape" });
          else this.keyStream.write(pending);
        }, 40);
      }
      break;
    }
  };

  private onKey = (text: string | undefined, key: readline.Key = {}): void => {
    if (!this.started) return;
    if (key.ctrl && key.name === "c") {
      if (this.confirmation || this.question) this.cancelConfirmation();
      if (this.busy) this.options.onCancel();
      else if (this.editor.text) this.editor.set("");
      else this.options.onExit();
    } else if (this.confirmation) {
      if (key.name === "y" && !key.ctrl && !key.meta)
        this.resolveConfirmation(true);
      else if (["n", "escape", "return", "enter"].includes(key.name ?? ""))
        this.resolveConfirmation(false);
      else if (key.name === "pagedown" || key.name === "down")
        this.confirmation.scroll += 1;
      else if (key.name === "pageup" || key.name === "up")
        this.confirmation.scroll = Math.max(0, this.confirmation.scroll - 1);
    } else if (key.name === "escape") {
      if (this.busy) this.options.onCancel();
    } else if (key.ctrl && key.name === "d" && !this.editor.text)
      this.options.onExit();
    else if (key.ctrl && key.name === "o")
      this.showThinking = !this.showThinking;
    else if (key.ctrl && key.name === "t") this.showTodos = !this.showTodos;
    else if (key.name === "pageup")
      this.scroll += Math.max(1, (this.output.rows || 24) - 10);
    else if (key.name === "pagedown")
      this.scroll = Math.max(
        0,
        this.scroll - Math.max(1, (this.output.rows || 24) - 10),
      );
    else if (key.ctrl && key.name === "end") this.scroll = 0;
    else if (key.shift && key.name === "tab") {
      if (!this.busy && !this.question) this.options.onCycleMode();
    } else if (key.name === "tab") {
      const matches = this.completions();
      if (matches.length === 1) this.editor.set(`/${matches[0]} `);
    } else if (
      (key.meta && key.name === "return") ||
      (key.ctrl && key.name === "j") ||
      key.sequence === "\x1b[13;2u" ||
      key.sequence === "\x1b[27;2;13~"
    )
      this.editor.insert("\n");
    else if (key.name === "return" || key.name === "enter") this.submit();
    else if (key.name === "backspace") this.editor.backspace();
    else if (key.name === "delete") this.editor.delete();
    else if (key.name === "left") this.editor.left();
    else if (key.name === "right") this.editor.right();
    else if (key.name === "home" || (key.ctrl && key.name === "a"))
      this.editor.home();
    else if (key.name === "end" || (key.ctrl && key.name === "e"))
      this.editor.end();
    else if (key.ctrl && key.name === "u") this.editor.set("");
    else if (key.name === "up" || key.name === "down") {
      if (this.editor.text.includes("\n"))
        this.editor.vertical(key.name === "up" ? -1 : 1);
      else this.navigateHistory(key.name === "up" ? -1 : 1);
    } else if (text && !key.ctrl && !key.meta && !text.startsWith("\x1b"))
      this.editor.insert(text);
    this.scheduleRender();
  };

  private submit(): void {
    const text = this.editor.text.trim();
    if (!text) return;
    if (this.question) {
      this.add("system", `Answer: ${text}`);
      this.resolveQuestion(text);
      return;
    }
    if (!/^\/key(?:\s|$)/i.test(text))
      this.history = [...this.history.filter((h) => h !== text), text].slice(
        -200,
      );
    this.historyIndex = this.history.length;
    this.historyDraft = "";
    this.editor.set("");
    this.scroll = 0;
    this.options.onSubmit(text);
  }

  private navigateHistory(direction: number): void {
    if (this.historyIndex === this.history.length)
      this.historyDraft = this.editor.text;
    this.historyIndex = Math.max(
      0,
      Math.min(this.history.length, this.historyIndex + direction),
    );
    this.editor.set(
      this.historyIndex === this.history.length
        ? this.historyDraft
        : this.history[this.historyIndex],
    );
  }

  private completions(): string[] {
    return !this.question && /^\/\w*$/.test(this.editor.text)
      ? TUI_COMMANDS.filter((c) => c.startsWith(this.editor.text.slice(1)))
      : [];
  }

  private scheduleRender = (): void => {
    if (!this.started || this.renderTimer) return;
    this.renderTimer = setTimeout(() => {
      this.renderTimer = undefined;
      this.render();
    }, 33);
  };

  /** Pure frame builder used by terminal integration tests and resize handling. */
  frame(
    columns = this.output.columns || 80,
    rows = this.output.rows || 24,
  ): {
    lines: string[];
    cursorRow: number;
    cursorColumn: number;
    cursorVisible: boolean;
  } {
    columns = Math.max(2, columns);
    rows = Math.max(1, rows);
    // Keep one column free to avoid terminal auto-wrap at the bottom edge.
    const width = columns - 1;
    const header = fit(
      `CODEAGENT  ${this.status.running ? "WORKING" : "READY"}  ${this.status.workspace}`,
      width,
    );
    const elapsed = this.status.running
      ? ` · ${Math.floor((Date.now() - this.startedAt) / 1000)}s`
      : "";
    const status = fit(
      `${this.status.mode} · ${this.status.model} · ${this.status.sandbox}${elapsed} · queue:${this.status.queued} · tokens:${this.status.inputTokens}/${this.status.outputTokens} · $${this.status.costUsd.toFixed(4)}`,
      width,
    );
    if (rows < 10 || columns < 24)
      return {
        lines: [fit("Terminal too small — resize", width), status].slice(
          0,
          rows,
        ),
        cursorRow: 1,
        cursorColumn: 1,
        cursorVisible: false,
      };
    const border = "─".repeat(width);
    if (this.confirmation) {
      const body = wrapText(this.confirmation.body, width);
      const available = rows - 6;
      this.confirmation.scroll = Math.min(
        this.confirmation.scroll,
        Math.max(0, body.length - available),
      );
      const visible = body.slice(
        this.confirmation.scroll,
        this.confirmation.scroll + available,
      );
      const lines = [
        header,
        status,
        border,
        fit(this.confirmation.title, width),
        ...visible,
      ];
      while (lines.length < rows - 2) lines.push("");
      lines.push(border, fit("y allow · Enter/n/Esc deny · ↑↓ scroll", width));
      return { lines, cursorRow: 1, cursorColumn: 1, cursorVisible: false };
    }
    const editorWidth = Math.max(1, width - 2);
    const editorLines = wrapText(this.editor.text, editorWidth);
    const before = wrapText(
      this.editor.text.slice(0, this.editor.cursor),
      editorWidth,
    );
    let cursorLine = before.length - 1;
    let cursorCell = cellWidth(before[cursorLine]);
    if (cursorCell === editorWidth) {
      cursorLine++;
      cursorCell = 0;
      if (!editorLines[cursorLine]) editorLines.push("");
    }
    const editorHeight = Math.min(5, editorLines.length);
    const editorStart = Math.max(0, cursorLine - editorHeight + 1);
    const shownEditor = editorLines
      .slice(editorStart, editorStart + editorHeight)
      .map((l, i) => `${i + editorStart === 0 ? "> " : "· "}${l}`);
    const completions = this.completions();
    const hint = this.question
      ? "Enter answer · Alt+Enter newline · Esc cancel task"
      : completions.length
        ? `Tab: ${completions.map((c) => `/${c}`).join(" ")}`
        : "Enter send · Alt+Enter/Ctrl+J newline · PgUp/PgDn scroll · Esc cancel";
    const todos = this.showTodos
      ? this.todos.slice(0, Math.min(3, rows - 10))
      : [];
    const viewportHeight = Math.max(
      1,
      rows - 6 - shownEditor.length - todos.length,
    );
    const transcript: string[] = [];
    for (const entry of this.entries) {
      if (entry.role === "thinking" && !this.showThinking) {
        transcript.push("Thinking… (Ctrl+O to expand)");
        continue;
      }
      const title =
        entry.role === "tool"
          ? `${entry.title} [${entry.state}]`
          : entry.role.toUpperCase();
      transcript.push(fit(title, width));
      const body = wrapText(entry.text, width);
      // Tool output remains bounded and shows the live tail; /diff provides
      // the full current diff in the scrollable transcript.
      if (entry.role === "tool" && body.length > 6)
        transcript.push(
          `… ${body.length - 6} earlier lines`,
          ...body.slice(-6),
        );
      else transcript.push(...body);
      transcript.push("");
    }
    if (this.scroll > 0 && this.lastWidth === width) {
      this.scroll = Math.max(
        0,
        this.scroll + transcript.length - this.lastTranscriptLines,
      );
    }
    this.lastTranscriptLines = transcript.length;
    this.lastWidth = width;
    this.scroll = Math.min(
      this.scroll,
      Math.max(0, transcript.length - viewportHeight),
    );
    const end = Math.max(0, transcript.length - this.scroll);
    const visible = transcript.slice(Math.max(0, end - viewportHeight), end);
    while (visible.length < viewportHeight) visible.push("");
    const position = this.scroll
      ? fit(`↑ ${this.scroll} lines below · Ctrl+End follow output`, width)
      : border;
    const lines = [
      header,
      status,
      border,
      ...visible,
      ...todos.map((t) => fit(t, width)),
      position,
      ...shownEditor,
      border,
      fit(hint, width),
    ];
    return {
      lines: lines.slice(0, rows),
      cursorRow: 5 + viewportHeight + todos.length + cursorLine - editorStart,
      cursorColumn: Math.min(width, 3 + cursorCell),
      cursorVisible: true,
    };
  }

  private render(): void {
    if (!this.started) return;
    const frame = this.frame();
    const color = process.env.NO_COLOR === undefined;
    const lines = frame.lines.map(
      (line, i) =>
        `${color && i === 0 ? "\x1b[1;36m" : ""}${line}${color ? "\x1b[0m" : ""}\x1b[K`,
    );
    this.output.write(
      `\x1b[?25l\x1b[H${lines.join("\r\n")}\x1b[J\x1b[${frame.cursorRow};${frame.cursorColumn}H${frame.cursorVisible ? "\x1b[?25h" : ""}`,
    );
  }
}
