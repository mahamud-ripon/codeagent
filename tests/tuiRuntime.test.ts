import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TuiApp } from "../src/cli/tui/app.js";
import { RuntimeClient } from "../src/runtime/client.js";
import { startSupervisor } from "../src/runtime/supervisor.js";
import type { CliArgs } from "../src/index.js";
import type { RuntimeEvent } from "../src/runtime/contracts.js";
const dirs: string[] = [];
async function temp() { const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ca-tui-")); dirs.push(dir); return dir; }
afterEach(async () => { for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true, maxRetries: 5 }); });
const done = (text = "Answer") => ({ output: [], output_text: text });
async function until(test: () => boolean) { const end = Date.now() + 10000; while (!test()) { if (Date.now() > end) throw new Error("Timed out waiting for UI state"); await new Promise(r => setTimeout(r, 10)); } }
describe("TUI with the real supervisor", () => {
  it("streams one answer, resumes history, lists sessions and handles local commands", async () => {
    const home = await temp(), root = await temp(); let calls = 0;
    const service = await startSupervisor(home, { responder: async () => { calls++; return done("Hello from runtime"); }, verbose: false });
    const client = new RuntimeClient(home), app = new TuiApp(client, { repo: root, task: "", maxIterations: 5, model: "test" } as CliArgs, "test");
    try {
      await app.send("what is codeagent?"); await until(() => app.state.status === "completed");
      const id = app.state.sessionId!;
      expect(app.state.entries.filter(e => e.kind === "assistant").map(e => e.text)).toEqual(["Hello from runtime"]);
      await app.send("/sessions"); expect(app.state.sessions.map(s => s.id)).toContain(id);
      await app.send("/new"); expect(app.state.sessionId).toBeUndefined();
      await app.send(`/resume ${id}`); expect(app.state.entries.filter(e => e.kind === "assistant")).toHaveLength(1);
      await app.send("/unknown"); expect(calls).toBe(1); expect(app.state.entries.at(-1)?.text).toContain("Unknown command");
      await app.send("/fork"); expect(app.state.sessionId).not.toBe(id); expect(app.state.entries.some(e => e.text === "Hello from runtime")).toBe(true);
    } finally { app.close(); await service.close(); }
  }, 30000);
  it("retains approvals across detach and sends denial for the displayed action only", async () => {
    const home = await temp(), root = await temp(); let calls = 0;
    const service = await startSupervisor(home, { responder: async () => ++calls === 1 ?
      { output: [{ type: "function_call", call_id: "cmd", name: "run_command", arguments: JSON.stringify({ command: "echo tui-approved" }) }] } : done("Denied safely"), verbose: false });
    const client = new RuntimeClient(home), args = { repo: root, task: "", maxIterations: 5, model: "test" } as CliArgs;
    const a = new TuiApp(client, args, "test"), b = new TuiApp(client, args, "test");
    try {
      await a.send("Run the command"); await until(() => a.state.pending.size === 1);
      const id = a.state.sessionId!, pendingId = [...a.state.pending.keys()][0]; a.close();
      await b.open(id); expect([...b.state.pending.keys()]).toEqual([pendingId]);
      await b.send("maybe"); expect(b.state.pending.size).toBe(1);
      await b.send(""); await until(() => b.state.status === "completed");
      const events = await client.request<RuntimeEvent[]>("events", { sessionId: id });
      expect(events.filter(e => e.type === "approval_response").map(e => e.data)).toEqual([expect.objectContaining({ id: pendingId, answer: false })]);
      expect(b.state.entries.some(e => e.kind === "tool" && e.status === "failed" && e.text.includes("denied"))).toBe(true);
      expect(events.some(e => e.type === "tool_intent" && e.data.name === "run_command")).toBe(false);
    } finally { a.close(); b.close(); await service.close(); }
  }, 30000);
  it("aborts an event subscription without cancelling the detached run", async () => {
    const home = await temp(), root = await temp(); let entered = false, release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const service = await startSupervisor(home, { responder: async () => { entered = true; await gate; return done("Survived detach"); }, verbose: false });
    const client = new RuntimeClient(home), app = new TuiApp(client, { repo: root, task: "", maxIterations: 3, model: "test" } as CliArgs, "test");
    try {
      await app.send("what is codeagent?"); await until(() => entered);
      const id = app.state.sessionId!, controller = new AbortController();
      const poll = client.request("events", { sessionId: id, after: 100000, wait: true }, controller.signal);
      controller.abort(); await expect(poll).rejects.toThrow("Client detached");
      app.close(); release();
      const handle = await client.attach(id);
      expect((await handle.result()).finalMessage).toBe("Survived detach");
      const b = new TuiApp(client, app.args, "test");
      try { await b.open(id); expect(b.state.status).toBe("completed"); expect(b.state.entries.some(e => e.text === "Survived detach")).toBe(true); }
      finally { b.close(); }
    } finally { release(); app.close(); await service.close(); }
  }, 30000);
  it("cancels active work through the supervisor and keeps the screen usable", async () => {
    const home = await temp(), root = await temp(); let entered = false;
    const service = await startSupervisor(home, { responder: async () => { throw new Error("Expected stream"); },
      providerInstance: { async *stream(req) {
        entered = true;
        await new Promise<void>((resolve, reject) => {
          if (req.signal?.aborted) return reject(new Error("Cancelled"));
          req.signal?.addEventListener("abort", () => reject(new Error("Cancelled")), { once: true });
        });
        yield { type: "stop" as const, finishReason: "stop" };
      } }, verbose: false });
    const app = new TuiApp(new RuntimeClient(home), { repo: root, task: "", maxIterations: 3, model: "test" } as CliArgs, "test");
    try {
      await app.send("what is codeagent?"); await until(() => entered);
      await app.cancel(); await until(() => app.state.activity === "cancelled");
      expect(app.state.entries.some(e => e.kind === "assistant")).toBe(true);
      await app.send("/new"); expect(app.state.status).toBe("ready");
    } finally { app.close(); await service.close(); }
  }, 30000);
});
