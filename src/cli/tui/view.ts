import { stringWidth } from "../ui/theme.js";
import { safeText, TuiState, views } from "./state.js";
const color = (code: string, text: string, enabled: boolean) => enabled ? `\x1b[${code}m${text}\x1b[0m` : text;
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
export const graphemes = (text: string) => [...segmenter.segment(text)].map((s) => s.segment);
export function terminalWidth(text: string): number {
  return graphemes(text).reduce((n, cluster) => n +
    (/\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(cluster) ? 2 :
      stringWidth(cluster.replace(/[\p{Mark}\p{Format}]/gu, ""))), 0);
}
export function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  for (const line of safeText(text).replace(/\t/g, "  ").split("\n")) {
    let row = "", used = 0;
    for (const ch of graphemes(line)) {
      const size = terminalWidth(ch);
      if (used + size > width && row) { lines.push(row); row = ""; used = 0; }
      if (size <= width) { row += ch; used += size; }
    }
    lines.push(row);
  }
  return lines;
}
export interface Frame { lines: string[]; cursorRow: number; cursorColumn: number }
export function renderFrame(state: TuiState, input: string, cursor: number, columns: number, rows: number, colors = true, tick = 0): Frame {
  const width = Math.max(1, columns - 2);
  const height = Math.max(1, rows);
  const paint = (text: string, code = "0") => color(code, wrap(text, width)[0] ?? "", colors);
  if (columns < 30 || rows < 18) return { lines: [paint("Enlarge terminal (30×18 min)", "33")], cursorRow: 1, cursorColumn: 1 };
  const active = ["running", "waiting_for_approval", "waiting_for_input", "connecting"].includes(state.status);
  const spinner = active ? ["◐", "◓", "◑", "◒"][tick % 4] : "●";
  const header = [
    paint(` ◆ CodeAgent 1.0   ${spinner} ${state.status.replaceAll("_", " ")}`, "1;36"),
    paint(` ${state.repo}  ·  ${state.model}`, "90"),
    paint(` ${state.permissions}  ·  Session ${state.sessionId?.slice(0, 8) ?? "new"}`, "90"),
    paint(views.map((v) => v === state.view ? `[${v}]` : ` ${v} `).join(" "), "36"),
    paint("─".repeat(width), "90"),
  ];
  const body: string[] = [];
  const add = (text: string, code = "0") => { for (const row of wrap(text, width)) body.push(color(code, row, colors)); };
  if (state.view === "Chat" || state.view === "Activity") {
    if (!state.entries.length) {
      add("What would you like to build?", "1;37"); add("");
      add("Describe a task, ask about your code, or resume a session.", "90");
      add("Tab switches views · /help lists commands", "90");
    }
    for (const entry of state.entries) {
      if (entry.kind === "tool") {
        add(`${entry.status === "done" ? "✓" : entry.status === "failed" ? "✕" : "›"} ${entry.agent}: ${entry.text}`,
          entry.status === "failed" ? "31" : "90");
        if (state.view === "Activity" && entry.detail) add(entry.detail, "90");
      } else {
        add("");
        add(entry.kind === "user" ? " YOU" : entry.kind === "assistant" ? " CODEAGENT" : " NOTICE",
          entry.kind === "user" ? "1;35" : "1;36");
        let code = false;
        for (const line of entry.text.split("\n")) {
          if (line.trim().startsWith("```")) { code = !code; add(code ? `┌ ${line.trim().slice(3) || "code"}` : "└", "90"); continue; }
          if (code) add(`│ ${line}`, "33");
          else add(line.replace(/^#{1,6}\s+/, "").replace(/\*\*([^*]+)\*\*/g, "$1").replace(/`([^`]+)`/g, "$1"),
            /^#/.test(line) ? "1;36" : entry.kind === "notice" ? "90" : "0");
        }
      }
    }
  } else if (state.view === "Tasks") {
    add("TASKS & VERIFICATION", "1;36");
    if (!state.tasks.length) add("No tasks yet.", "90");
    for (const t of state.tasks) {
      add(`${t.status === "completed" ? "✓" : "○"} ${t.objective} · ${t.status}`, t.status === "completed" ? "32" : "0");
      add(`  Owner: ${t.owner ?? "unassigned"} · Dependencies: ${t.dependencies.join(", ") || "none"}`, "90");
      for (const criterion of t.acceptance) add(`  • ${criterion}`, "90");
    }
    add(""); add("Checks", "1;36");
    if (!state.checks.length) add("No verification recorded.", "90");
    for (const check of state.checks) add(`${check.valid && check.exitCode === 0 ? "✓" : "○"} ${check.command} · ${check.valid ? `exit ${check.exitCode}` : "stale"}`,
      check.valid && check.exitCode === 0 ? "32" : "33");
  } else if (state.view === "Agents") {
    add(`Coordinator · ${state.status}`, "1;36");
    if (!state.workers.size) add("No delegated workers.", "90");
    for (const [id, w] of state.workers) add(`${id} · ${w.role} · ${w.status}`);
  } else if (state.view === "Jobs") {
    add("BACKGROUND JOBS", "1;36");
    if (!state.jobs.length) add("No background jobs.", "90");
    for (const job of state.jobs) { add(`${job.id} · ${job.done ? `exit ${job.exitCode ?? "?"}` : "running"} · ${job.command}`); add(job.output?.slice(-1500) ?? "", "90"); }
  } else {
    add("SESSIONS · ↑/↓ to select · Enter to open", "1;36");
    if (!state.sessions.length) add("No saved sessions.", "90");
    const first = Math.max(0, state.selectedSession - Math.max(1, Math.floor((rows - 15) / 2)));
    state.sessions.slice(first, first + Math.max(1, rows - 14)).forEach((s, index) => { const i = first + index; add(`${i === state.selectedSession ? "›" : " "} ${s.id.slice(0, 8)} · ${s.status} · ${s.repoRoot}`,
      i === state.selectedSession ? "1;36" : "0"); });
  }
  const pending = [...state.pending.values()][0];
  const footer: string[] = [];
  if (pending) {
    footer.push(paint(pending.kind === "approval" ? " APPROVAL REQUIRED · y = allow once · Enter/n = deny" : " INPUT REQUIRED · type your answer", "1;33"));
    const prompt = wrap(`${pending.agentId ?? "coordinator"}: ${pending.prompt}`, width);
    // Full approval details are also in Activity; never replace the pending action with another id.
    footer.push(...prompt.slice(-Math.min(3, Math.floor(rows / 5))).map((s) => paint(s, "33")));
  } else footer.push(paint(` ${state.scroll ? "History · Ctrl+End for live output · " : ""}${state.activity}`, "90"));
  footer.push(paint("─".repeat(width), "36"));
  const inputLines = wrap(`❯ ${input}`, width);
  const prefix = graphemes(input).slice(0, cursor).join("");
  const before = wrap(`❯ ${prefix}`, width);
  const start = Math.max(0, before.length - 3);
  const visibleInput = inputLines.slice(start, start + 3);
  footer.push(...visibleInput.map((s) => paint(s, "1;37")));
  const cursorInFooter = footer.length - visibleInput.length + before.length - start;
  footer.push(paint("─".repeat(width), "36"));
  footer.push(paint(` ${state.usage.input.toLocaleString()} in · ${state.usage.output.toLocaleString()} out · ${state.usage.cached.toLocaleString()} cached · ${state.usage.cost === null ? "cost unknown" : `$${state.usage.cost.toFixed(4)}`}`, "90"));
  footer.push(paint(" Tab views · PgUp/PgDn scroll · Esc cancel · Ctrl+D detach · /help", "90"));
  const available = Math.max(1, height - header.length - footer.length);
  const offset = Math.min(state.scroll, Math.max(0, body.length - available));
  const end = Math.max(0, body.length - offset);
  const viewport = body.slice(Math.max(0, end - available), end);
  while (viewport.length < available) viewport.push("");
  return { lines: [...header, ...viewport, ...footer].slice(0, height),
    cursorRow: Math.min(height, header.length + viewport.length + cursorInFooter),
    cursorColumn: Math.min(width + 1, terminalWidth(before.at(-1) ?? "") + 1) };
}
