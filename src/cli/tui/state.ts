import { stripVTControlCharacters } from "node:util";
import type { RuntimeEvent, TaskRecord, VerificationRecord } from "../../runtime/contracts.js";

export const views = ["Chat", "Activity", "Tasks", "Agents", "Jobs", "Sessions"] as const;
export type View = typeof views[number];
export interface Entry { kind: "user" | "assistant" | "tool" | "notice"; text: string; detail?: string; agent?: string; id?: string; status?: string }
export interface Pending { id: string; kind: "approval" | "input"; prompt: string; agentId?: string }
export interface SessionItem { id: string; repoRoot: string; status: string }
export interface JobItem { id: string; command: string; done: boolean; exitCode?: number; output?: string }
export function safeText(value: unknown): string {
  return stripVTControlCharacters(String(value ?? "")).replace(/\r\n?/g, "\n")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "");
}
const bounded = (s: string) => s.length > 64000 ? "[Earlier content available in session history]\n" + s.slice(-60000) : s;
export class TuiState {
  view: View = "Chat";
  sessionId?: string;
  runId?: string;
  status = "ready";
  activity = "Ready for your next task";
  entries: Entry[] = [];
  tasks: TaskRecord[] = [];
  checks: VerificationRecord[] = [];
  workers = new Map<string, { role: string; status: string }>();
  jobs: JobItem[] = [];
  sessions: SessionItem[] = [];
  pending = new Map<string, Pending>();
  usage = { input: 0, output: 0, cached: 0, cost: null as number | null };
  scroll = 0;
  selectedSession = 0;
  private assistant?: Entry;
  constructor(public repo: string, public model: string, public permissions: string) {}
  add(entry: Entry): void {
    entry.text = bounded(safeText(entry.text));
    this.entries.push(entry);
    if (this.entries.length > 500) this.entries.splice(0, this.entries.length - 500);
  }
  notice(text: string): void { this.add({ kind: "notice", text }); }
  apply(e: RuntimeEvent): void {
    const d = e.data;
    const root = e.agentId === "coordinator";
    if (e.type === "runtime_origin" && root) {
      this.runId = e.runId;
      this.assistant = undefined;
      this.usage = { input: 0, output: 0, cached: 0, cost: null };
    }
    if (e.type === "status" && root) this.status = String(d.status);
    if (e.type === "model_start" && root && d.role !== "compaction") {
      this.assistant = undefined;
      this.activity = `Thinking · turn ${d.turn}`;
    }
    if (e.type === "text_delta" && root) {
      if (!this.assistant) { this.assistant = { kind: "assistant", text: "" }; this.add(this.assistant); }
      this.assistant.text = bounded(this.assistant.text + safeText(d.text));
      this.activity = "Writing response";
    }
    if (e.type === "message" && root) {
      const m = d.message as { kind?: string; role?: string; text?: string; id?: string } | undefined;
      // Authorization/validation failures occur before a tool intention exists.
      if (m?.kind === "result" && m.text?.startsWith("TOOL ERROR") && !this.entries.some((entry) => entry.id === m.id && entry.agent === e.agentId))
        this.add({ kind: "tool", id: m.id, agent: e.agentId, status: "failed", text: m.text });
      if (m?.kind === "text" && m.role === "user" && !m.text?.startsWith("Session continuity:"))
        this.add({ kind: "user", text: m.text ?? "" });
      if (m?.kind === "text" && m.role === "assistant") {
        if (!this.assistant) { this.assistant = { kind: "assistant", text: "" }; this.add(this.assistant); }
        this.assistant.text = bounded(safeText(m.text));
      }
    }
    if (e.type === "tool_intent") {
      const args = (d.args ?? {}) as Record<string, unknown>;
      this.add({ kind: "tool", id: e.correlationId, agent: e.agentId, status: "running",
        text: `${d.name}  ${safeText(args.path ?? args.command ?? args.pattern ?? args.name ?? "").slice(0, 250)}` });
      this.activity = `Running ${d.name}`;
    }
    if (e.type === "tool_output_delta") {
      const tool = [...this.entries].reverse().find((entry) => entry.kind === "tool" && entry.agent === e.agentId);
      if (tool) tool.detail = ((tool.detail ?? "") + safeText(d.chunk)).slice(-4000);
    }
    if (e.type === "tool_result") {
      const tool = [...this.entries].reverse().find((entry) => entry.id === e.correlationId && entry.agent === e.agentId);
      if (tool) {
        tool.status = d.ok ? "done" : "failed";
        tool.detail = safeText(d.error ?? d.output).slice(-4000);
        tool.text += ` · ${Number(d.ms ?? 0)}ms`;
      }
    }
    if (e.type === "tasks" && root) this.tasks = (d.tasks ?? []) as TaskRecord[];
    if (e.type === "verification") {
      const record = d.record as VerificationRecord;
      if (record) this.checks = [...this.checks.filter((r) => r.id !== record.id), record].slice(-50);
    }
    if (e.type === "worker_started") this.workers.set(String(d.id), { role: String(d.role), status: "running" });
    if (["worker_finished", "worker_failed", "worker_integrated"].includes(e.type)) {
      const worker = this.workers.get(String(d.id));
      if (worker) worker.status = e.type === "worker_integrated" ? "integrated" : String(d.status ?? "failed");
    }
    if (e.type === "usage" && root) this.usage = { input: Number(d.input ?? 0), output: Number(d.output ?? 0),
      cached: Number(d.cachedInput ?? 0), cost: typeof d.costUsd === "number" ? d.costUsd : null };
    if (e.type === "approval_request" || e.type === "input_request") {
      this.view = "Activity";
      this.scroll = 0;
      this.notice(`Request from ${d.agentId ?? e.agentId}:\n${safeText(d.prompt)}`);
      this.pending.set(String(d.id), { id: String(d.id), kind: e.type === "approval_request" ? "approval" : "input",
        prompt: safeText(d.prompt), agentId: String(d.agentId ?? e.agentId) });
    }
    if (e.type === "approval_response" || e.type === "input_response") this.pending.delete(String(d.id));
    if (e.type === "provider_error") this.activity = `Provider retry ${d.attempt}: ${safeText(d.error).slice(0, 160)}`;
    if (e.type === "compaction") this.notice("Context compacted; session history is preserved.");
    if (e.type === "done" && root) {
      const final = bounded(safeText(d.finalMessage));
      if (this.assistant && final.startsWith(this.assistant.text)) this.assistant.text = final;
      else if (final && final !== this.assistant?.text) this.add({ kind: "assistant", text: final });
      this.status = String(d.status);
      this.activity = String(d.status);
      this.pending.clear();
    }
  }
}
