/**
 * UI-1…UI-13 (--ui=next): Ink-parity roadmap implemented on the zero-dep
 * console renderer. The readline REPL stays the default; --ui=next opts
 * into this streaming UI. Pure helpers are unit-tested; the live loop in
 * repl.ts consumes AgentEvents through renderNextEvent().
 */
import type { AgentEvent } from "../llm/events.js";
import { pc } from "../cli/ui/index.js";

export type UiThemeName = "dark" | "light" | "colorblind";

export function isNoColor(): boolean {
  return !!process.env.NO_COLOR;
}

export function themePalette(theme: UiThemeName): { accent: (s: string) => string; ok: (s: string) => string } {
  if (isNoColor()) return { accent: (s) => s, ok: (s) => s };
  if (theme === "light") return { accent: (s) => `\x1b[34m${s}\x1b[0m`, ok: (s) => `\x1b[32m${s}\x1b[0m` };
  if (theme === "colorblind") return { accent: (s) => `\x1b[36m${s}\x1b[0m`, ok: (s) => `\x1b[33m${s}\x1b[0m` };
  return { accent: (s) => pc.cyan(s), ok: (s) => pc.green(s) };
}

/** UI-2: incremental markdown — headings, lists, code fences highlighted per chunk. */
export function renderMarkdownChunk(chunk: string, inCodeFence: boolean): { text: string; inCodeFence: boolean } {
  let fence = inCodeFence;
  const out: string[] = [];
  for (const line of chunk.split("\n")) {
    if (/^\s*```/.test(line)) {
      fence = !fence;
      out.push(pc.dim(line));
      continue;
    }
    if (fence) {
      out.push(`  ${line}`);
      continue;
    }
    if (/^#{1,6}\s/.test(line)) out.push(pc.bold(line));
    else if (/^\s*[-*]\s/.test(line)) out.push(`  ${pc.cyan("•")} ${line.replace(/^\s*[-*]\s/, "")}`);
    else if (/^\s*\d+\.\s/.test(line)) out.push(`  ${line.trim()}`);
    else if (/`[^`]+`/.test(line)) out.push(line.replace(/`([^`]+)`/g, (_, code) => pc.yellow(`\`${code}\``)));
    else out.push(line);
  }
  return { text: out.join("\n"), inCodeFence: fence };
}

/** UI-4: unified diff preview for the permission prompt (color + line numbers + symbols). */
export function renderDiffPreview(oldText: string, newText: string, maxLines = 40): string {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  const out: string[] = [];
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < Math.min(n, maxLines); i++) {
    const o = a[i];
    const nn = b[i];
    if (o === nn) out.push(pc.dim(`  ${i + 1} │ ${o ?? ""}`));
    else {
      if (o !== undefined) out.push(pc.red(`- ${i + 1} │ ${o}`));
      if (nn !== undefined) out.push(pc.green(`+ ${i + 1} │ ${nn}`));
    }
  }
  if (n > maxLines) out.push(pc.dim(`… ${n - maxLines} more lines`));
  return out.join("\n");
}

/** UI-7: status line — model, branch/dirty, context %, cost, mode, sandbox. */
export function renderStatusLine(opts: {
  model: string;
  branch?: string;
  dirty?: boolean;
  contextPct?: number;
  costUsd?: number;
  mode?: string;
  sandbox?: string;
}): string {
  const parts = [
    `model:${opts.model}`,
    opts.branch ? `${opts.branch}${opts.dirty ? "*" : ""}` : null,
    opts.contextPct !== undefined ? `ctx:${Math.round(opts.contextPct)}%` : null,
    opts.costUsd !== undefined ? `$${opts.costUsd.toFixed(4)}` : null,
    opts.mode ? opts.mode : null,
    opts.sandbox ? `sandbox:${opts.sandbox}` : null,
  ].filter(Boolean);
  const text = parts.join(" · ");
  return text.length > 80 ? text.slice(0, 77) + "…" : text;
}

/** UI-12: fuzzy picker filter (sessions, models, checkpoints). Pure. */
export function fuzzyFilter<T>(items: T[], query: string, text: (t: T) => string): T[] {
  const q = query.toLowerCase().replace(/\s+/g, "");
  if (!q) return items;
  const scored = items.map((item) => {
    const hay = text(item).toLowerCase();
    let qi = 0;
    let score = 0;
    for (let hi = 0; hi < hay.length && qi < q.length; hi++) {
      if (hay[hi] === q[qi]) { score += 2; qi++; }
      else if (hay.includes(q.slice(qi, qi + 2))) score += 1;
    }
    return { item, score: qi === q.length ? score : -1 };
  }).filter((s) => s.score >= 0);
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.item);
}

/** UI-10: queued messages while the agent runs. */
export class MessageQueue {
  private items: string[] = [];
  enqueue(msg: string): void {
    if (msg.trim()) this.items.push(msg.trim());
  }
  drain(): string[] {
    const out = this.items;
    this.items = [];
    return out;
  }
  get size(): number {
    return this.items.length;
  }
}

/** UI-8/5/6 helpers: Esc-interrupt note, multiline detection, @/#//autocomplete kinds. */
export function isMultilineSubmit(buffer: string): boolean {
  // Shift+Enter inserts a newline; plain Enter on a balanced buffer submits.
  const open = (buffer.match(/```/g) ?? []).length % 2 === 1;
  return !open;
}

export type AutocompleteKind = "command" | "file" | "shell" | "memory" | null;

export function autocompleteKindFor(buffer: string): AutocompleteKind {
  const last = buffer.split("\n").pop()?.trimStart() ?? "";
  if (last.startsWith("/")) return "command";
  if (last.startsWith("@")) return "file";
  if (last.startsWith("!")) return "shell";
  if (last.startsWith("#")) return "memory";
  return null;
}

/** Live event renderer for --ui=next: returns lines to print (empty when buffering). */
export function renderNextEvent(
  event: AgentEvent,
  state: { codeFence: boolean; theme?: UiThemeName },
): { lines: string[]; codeFence: boolean } {
  switch (event.type) {
    case "text_delta": {
      const r = renderMarkdownChunk(event.text, state.codeFence);
      return { lines: r.text ? [r.text] : [], codeFence: r.inCodeFence };
    }
    case "tool_start":
      return { lines: [`${pc.cyan("⏺")} ${pc.bold(String(event.name))} ${pc.dim(JSON.stringify(event.args ?? {}).slice(0, 120))}`], codeFence: state.codeFence };
    case "tool_end":
      return { lines: [`  ${pc.dim("⎿")} ${event.ok ? pc.dim(event.output.slice(0, 200)) : pc.red(event.output.slice(0, 200))}`], codeFence: state.codeFence };
    case "usage":
      return { lines: [pc.dim(`[tokens ${event.input} in / ${event.output} out${event.costUsd !== undefined ? ` · $${event.costUsd.toFixed(4)}` : ""}]`)], codeFence: state.codeFence };
    case "error":
      return { lines: [pc.red(`Error: ${event.message}`)], codeFence: state.codeFence };
    default:
      return { lines: [], codeFence: state.codeFence };
  }
}
