import { emitKeypressEvents, type Key } from "node:readline";
import type { CliArgs } from "../../index.js";
import { RuntimeClient } from "../../runtime/client.js";
import { TuiApp } from "./app.js";
import { safeText, views } from "./state.js";
import { graphemes, renderFrame } from "./view.js";

/** Grapheme-aware editor shared by the terminal driver and keyboard tests. */
export class InputEditor {
  value = "";
  cursor = 0;
  private history: string[] = [];
  private historyIndex = 0;
  private draft = "";
  clear(): void { this.value = ""; this.cursor = 0; this.historyIndex = this.history.length; }
  set(value: string): void { this.value = safeText(value).slice(0, 32000); this.cursor = graphemes(this.value).length; }
  insert(value: string): void {
    const chars = graphemes(this.value);
    const added = graphemes(safeText(value).slice(0, Math.max(0, 32000 - this.value.length)));
    chars.splice(this.cursor, 0, ...added);
    this.value = chars.join(""); this.cursor += added.length;
  }
  remember(): void {
    if (this.value && this.history.at(-1) !== this.value) this.history.push(this.value);
    if (this.history.length > 100) this.history.shift();
    this.clear();
  }
  key(key: Key): void {
    const chars = graphemes(this.value);
    if (key.name === "left") this.cursor = Math.max(0, this.cursor - 1);
    else if (key.name === "right") this.cursor = Math.min(chars.length, this.cursor + 1);
    else if (key.name === "home" || key.ctrl && key.name === "a") this.cursor = 0;
    else if (key.name === "end" || key.ctrl && key.name === "e") this.cursor = chars.length;
    else if (key.name === "backspace") { if (this.cursor) chars.splice(--this.cursor, 1); }
    else if (key.name === "delete") chars.splice(this.cursor, 1);
    else if (key.ctrl && key.name === "u") { chars.splice(0, this.cursor); this.cursor = 0; }
    else if (key.ctrl && key.name === "w") {
      const end = this.cursor;
      while (this.cursor && /\s/u.test(chars[this.cursor - 1])) this.cursor--;
      while (this.cursor && !/\s/u.test(chars[this.cursor - 1])) this.cursor--;
      chars.splice(this.cursor, end - this.cursor);
    } else if (key.name === "up" || key.name === "down") {
      if (this.historyIndex === this.history.length) this.draft = this.value;
      this.historyIndex = Math.max(0, Math.min(this.history.length, this.historyIndex + (key.name === "up" ? -1 : 1)));
      this.set(this.history[this.historyIndex] ?? this.draft); return;
    }
    this.value = chars.join("");
  }
}

export async function runTui(client: RuntimeClient, args: CliArgs, options: { sessionId?: string; task?: string; model: string }): Promise<void> {
  const app = new TuiApp(client, args, options.model);
  const input = process.stdin, output = process.stdout;
  const editor = new InputEditor();
  const wasRaw = input.isRaw;
  let closed = false, pasting = false, submitting = false, refreshingJobs = false, tick = 0;
  let lastLines: string[] = [], pendingId: string | undefined, savedDraft = "";
  let frameTimer: NodeJS.Timeout | undefined;
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => { finish = resolve; });
  const draw = () => {
    frameTimer = undefined;
    if (closed) return;
    const nextPending = [...app.state.pending.keys()][0];
    if (nextPending !== pendingId) {
      if (!pendingId) savedDraft = editor.value;
      editor.set(nextPending ? "" : savedDraft);
      pendingId = nextPending;
    }
    const frame = renderFrame(app.state, editor.value, editor.cursor, output.columns ?? 80, output.rows ?? 24, !("NO_COLOR" in process.env), tick);
    let update = "\x1b[?25l";
    for (let i = 0; i < Math.max(frame.lines.length, lastLines.length); i++) {
      if (frame.lines[i] !== lastLines[i]) update += `\x1b[${i + 1};1H\x1b[2K${frame.lines[i] ?? ""}`;
    }
    lastLines = frame.lines;
    output.write(`${update}\x1b[${frame.cursorRow};${frame.cursorColumn}H\x1b[?25h`);
  };
  const schedule = () => { if (!closed && !frameTimer) frameTimer = setTimeout(draw, 30); };
  const resize = () => { lastLines = []; output.write("\x1b[2J"); schedule(); };
  const safely = (work: Promise<unknown>) => { void work.catch((e) => app.error(e)); };
  const onKey = (text: string | undefined, key: Key = {}) => {
    if (closed) return;
    if (key.name === "paste-start") { pasting = true; return; }
    if (key.name === "paste-end") { pasting = false; schedule(); return; }
    if (pasting) { editor.insert(key.name === "return" ? "\n" : text ?? ""); schedule(); return; }
    // Synchronize a new prompt before interpreting any approval keystrokes.
    if ([...app.state.pending.keys()][0] !== pendingId) draw();
    if (key.ctrl && key.name === "d") { app.close(); return; }
    if (key.ctrl && key.name === "c") { if (app.active) safely(app.cancel()); else app.close(); return; }
    if (key.name === "escape") { if (app.active) safely(app.cancel()); else editor.clear(); }
    else if (key.name === "tab") {
      safely(app.setView(views[(views.indexOf(app.state.view) + (key.shift ? views.length - 1 : 1)) % views.length]));
    } else if (key.name === "pageup") app.state.scroll += Math.max(1, (output.rows ?? 24) - 12);
    else if (key.name === "pagedown") app.state.scroll = Math.max(0, app.state.scroll - Math.max(1, (output.rows ?? 24) - 12));
    else if (key.ctrl && key.name === "end") app.state.scroll = 0;
    else if (app.state.view === "Sessions" && !editor.value && !pendingId && ["up", "down"].includes(key.name ?? "")) {
      app.state.selectedSession = Math.max(0, Math.min(app.state.sessions.length - 1, app.state.selectedSession + (key.name === "up" ? -1 : 1)));
    } else if (key.name === "return" && !key.meta && !key.shift) {
      if (submitting) return;
      if (app.state.view === "Sessions" && !editor.value && !pendingId) {
        const session = app.state.sessions[app.state.selectedSession];
        if (session) { submitting = true; safely(app.open(session.id).finally(() => { submitting = false; })); }
      } else {
        const value = editor.value;
        if (pendingId) editor.clear(); else editor.remember();
        submitting = true;
        safely(app.send(value).finally(() => { submitting = false; schedule(); }));
      }
    } else if (key.name === "return" || key.name === "enter") editor.insert("\n");
    else if (!key.ctrl && !key.meta && text && !text.startsWith("\x1b") && !["backspace", "delete"].includes(key.name ?? "")) editor.insert(text);
    else editor.key(key);
    schedule();
  };
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearTimeout(frameTimer); clearInterval(animation);
    input.off("keypress", onKey); input.off("end", stop); output.off("resize", resize);
    process.off("SIGTERM", stop); process.off("SIGHUP", stop); process.off("SIGINT", stop); process.off("exit", cleanup);
    input.setRawMode(wasRaw ?? false);
    // stdin starts with isPaused() === false even before it has a consumer.
    // Pause our raw-input stream explicitly so detaching can exit naturally.
    input.pause();
    output.write("\x1b[0m\x1b[?2004l\x1b[?7h\x1b[?25h\x1b[?1049l");
    finish();
  };
  const stop = () => app.close();
  const animation = setInterval(() => {
    tick++; schedule();
    if (tick % 10 === 0 && app.state.view === "Jobs" && !refreshingJobs) {
      refreshingJobs = true;
      safely(app.refreshJobs().finally(() => { refreshingJobs = false; }));
    }
  }, 180);
  app.onChange = schedule; app.onExit = cleanup;
  try {
    emitKeypressEvents(input);
    input.setRawMode(true); input.resume();
    input.on("keypress", onKey); input.once("end", stop); output.on("resize", resize);
    process.once("SIGTERM", stop); process.once("SIGHUP", stop); process.once("SIGINT", stop); process.once("exit", cleanup);
    output.write("\x1b[?1049h\x1b[?7l\x1b[?2004h\x1b[2J");
    draw();
    safely(app.start(options.sessionId, options.task));
    await finished;
  } finally { app.close(); cleanup(); }
  if (app.state.sessionId) output.write(`Session ${safeText(app.state.sessionId)} · codeagent --resume ${safeText(app.state.sessionId)}\n`);
}
