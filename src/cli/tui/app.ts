import type { CliArgs } from "../../index.js";
import { RunHandle, RuntimeClient } from "../../runtime/client.js";
import type { RuntimeEvent, SessionSnapshot, TaskRecord, VerificationRecord } from "../../runtime/contracts.js";
import { TuiState, type JobItem, type Pending, type SessionItem, type View } from "./state.js";

const live = (status: string) => ["running", "waiting_for_approval", "waiting_for_input"].includes(status);
export class TuiApp {
  state: TuiState;
  onChange = () => {};
  onExit = () => {};
  private watchAbort?: AbortController;
  private handle?: RunHandle;
  private closed = false;
  private busy = false;
  private epoch = 0;
  constructor(public client: RuntimeClient, public args: CliArgs, private model: string) {
    this.state = new TuiState(args.repo, model, args.autoApprove ? "Auto approvals" : "Session approval policy");
  }
  get active(): boolean { return !!this.handle && live(this.state.status); }
  changed(): void { if (!this.closed) this.onChange(); }
  error(e: unknown): void { this.state.notice(e instanceof Error ? e.message : String(e)); this.changed(); }
  async start(sessionId?: string, task?: string): Promise<void> {
    if (sessionId) await this.open(sessionId);
    if (task && !this.closed) await this.send(task);
    this.changed();
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.epoch++;
    this.watchAbort?.abort();
    this.onExit(); // Detaching never cancels server-owned work.
  }
  private reset(): void {
    this.watchAbort?.abort();
    this.epoch++;
    this.handle = undefined;
    this.state = new TuiState(this.args.repo, this.model, this.args.autoApprove ? "Auto approvals" : "Session approval policy");
  }
  async open(id: string): Promise<void> {
    // Validate the destination before replacing the active view.
    const s = await this.client.request<SessionSnapshot & { pending: Pending[]; jobs: JobItem[] }>("inspect", { sessionId: id });
    const events = await this.client.request<RuntimeEvent[]>("events", { sessionId: id });
    if (this.closed) return;
    this.reset();
    this.state.sessionId = id;
    this.state.repo = s.repoRoot;
    this.state.model = "session model";
    // Replay the journal instead of duplicating snapshot messages and deltas.
    for (const event of events) this.state.apply(event);
    if (!events.some((e) => e.type === "message")) {
      for (const m of s.messages) if (m.kind === "text" && (m.role === "user" || m.role === "assistant"))
        this.state.add({ kind: m.role, text: m.text });
    }
    this.state.view = "Chat";
    this.state.status = s.status;
    this.state.tasks = s.tasks;
    this.state.checks = s.verifications;
    // Snapshot pending state is authoritative; old requests may already be answered.
    await this.refresh();
    if (this.state.pending.size) this.state.view = "Activity";
    if (s.runId && live(this.state.status)) this.watch(new RunHandle(this.client, id, s.runId), events.at(-1)?.sequence ?? 0);
    this.changed();
  }
  private watch(handle: RunHandle, after = 0): void {
    if (this.closed) return;
    this.watchAbort?.abort();
    const controller = new AbortController();
    this.watchAbort = controller;
    const epoch = ++this.epoch;
    this.handle = handle;
    this.state.runId = handle.runId;
    void (async () => {
      try {
        for await (const event of handle.events(after, controller.signal)) {
          if (epoch !== this.epoch || this.closed) break;
          this.state.apply(event);
          this.changed();
        }
        if (epoch === this.epoch && !this.closed) { this.handle = undefined; await this.refresh(); }
      } catch (e) {
        if (!controller.signal.aborted && epoch === this.epoch) {
          this.handle = undefined;
          this.state.status = "disconnected";
          this.error(e);
          this.state.notice("The run may still be active. Use /resume <session-id> to reconnect.");
          this.changed();
        }
      }
    })();
  }
  async refresh(): Promise<void> {
    const id = this.state.sessionId;
    const epoch = this.epoch;
    if (!id) return;
    const s = await this.client.request<{ status: string; pending: Pending[]; jobs: JobItem[]; tasks: TaskRecord[]; verifications: VerificationRecord[] }>("inspect", { sessionId: id });
    if (epoch !== this.epoch || this.closed || id !== this.state.sessionId) return;
    this.state.pending = new Map(s.pending.map((p) => [p.id, p]));
    this.state.jobs = s.jobs;
    this.state.tasks = s.tasks;
    this.state.checks = s.verifications;
    this.state.status = s.status;
    this.changed();
  }
  async refreshJobs(): Promise<void> {
    const id = this.state.sessionId;
    if (!id || this.closed) return;
    const snapshot = await this.client.request<{ jobs: JobItem[] }>("inspect", { sessionId: id });
    if (!this.closed && this.state.sessionId === id) { this.state.jobs = snapshot.jobs; this.changed(); }
  }
  async setView(view: View): Promise<void> {
    this.state.view = view;
    this.state.scroll = 0;
    if (view === "Sessions") {
      this.state.sessions = await this.client.request<SessionItem[]>("list");
      this.state.selectedSession = Math.min(this.state.selectedSession, Math.max(0, this.state.sessions.length - 1));
    } else if (["Tasks", "Agents", "Jobs"].includes(view)) await this.refresh();
    this.changed();
  }
  async cancel(): Promise<void> {
    if (this.handle) { await this.handle.cancel(); this.state.activity = "Cancelling…"; this.changed(); }
  }
  async send(text: string): Promise<void> {
    if (this.busy || this.closed) return;
    this.busy = true;
    try {
      const pending = [...this.state.pending.values()][0];
      if (pending && !text.startsWith("/")) {
        if (pending.kind === "approval" && !/^(y|yes|n|no)?$/i.test(text.trim())) {
          this.state.notice("Type y to approve once, or n/Enter to deny."); return;
        }
        // Use the exact action ID captured with the displayed prompt.
        await this.client.request("answer", { sessionId: this.state.sessionId, id: pending.id,
          answer: pending.kind === "approval" ? /^y(es)?$/i.test(text.trim()) : text });
        this.state.pending.delete(pending.id);
        return;
      }
      text = text.trim();
      if (!text) return;
      if (text.startsWith("/")) { await this.command(text); return; }
      if (this.active) {
        await this.handle!.steer(text);
        this.state.notice("Steering sent; the agent will read it at its next turn.");
        return;
      }
      if (this.state.status === "disconnected") throw new Error("Reconnect with /resume before submitting another task.");
      if (!this.state.sessionId) {
        const s = await this.client.create(this.args.repo, {
          model: this.args.model, provider: this.args.provider, baseURL: this.args.baseURL,
          maxIterations: this.args.maxIterations, autoApprove: this.args.autoApprove,
          allowedTools: this.args.allowedTools, sandboxMode: this.args.sandbox,
        });
        if (this.closed) return;
        this.state.sessionId = s.id;
      }
      this.state.view = "Chat";
      this.state.scroll = 0;
      this.state.status = "running";
      this.state.activity = "Starting run…";
      this.changed();
      this.watch(await this.client.submit(this.state.sessionId, text));
    } catch (e) {
      if (!this.handle && this.state.status === "running") this.state.status = "ready";
      this.error(e);
    } finally { this.busy = false; this.changed(); }
  }
  private async command(text: string): Promise<void> {
    const [command, ...parts] = text.split(/\s+/);
    const arg = parts.join(" ");
    const tabs: Record<string, View> = { "/chat": "Chat", "/activity": "Activity", "/tasks": "Tasks", "/agents": "Agents", "/jobs": "Jobs", "/sessions": "Sessions" };
    if (tabs[command]) { await this.setView(tabs[command]); return; }
    if (command === "/exit" || command === "/detach") { this.close(); return; }
    if (command === "/cancel") { await this.cancel(); return; }
    if (command === "/resume") { if (!arg) throw new Error("Usage: /resume <session-id>"); await this.open(arg); return; }
    if (command === "/new") { this.reset(); return; }
    if (command === "/pause") { if (this.handle) await this.handle.pause(); return; }
    if (command === "/status") { await this.refresh(); this.state.notice(`Session ${this.state.sessionId ?? "new"}: ${this.state.status}`); return; }
    if (command === "/fork" || command === "/undo") {
      if (!this.state.sessionId) throw new Error("No active session");
      if (command === "/fork") {
        const fork = await this.client.request<SessionSnapshot>("fork", { sessionId: this.state.sessionId });
        await this.open(fork.id);
      } else {
        const files = await this.client.request<string[]>("undo", { sessionId: this.state.sessionId });
        this.state.notice(`Restored ${files.length} files.`);
      }
      return;
    }
    if (command === "/help") {
      this.state.view = "Chat";
      this.state.notice("/new  /sessions  /resume <id>  /fork  /undo  /status\n/chat  /activity  /tasks  /agents  /jobs\n/cancel  /pause  /detach  /exit\nEnter sends. Alt+Enter adds a line. ↑/↓ recall input (select sessions in Sessions).\nTab changes view. PageUp/PageDown scroll; Ctrl+End returns to live output.\nEscape or Ctrl+C cancels an active run. Ctrl+D detaches, leaving work running.\nText submitted during a run steers the agent. Approvals require explicit y; Enter denies.");
      return;
    }
    throw new Error(`Unknown command ${command}. Use /help.`);
  }
}
