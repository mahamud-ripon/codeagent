import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { JournalStore } from "../src/runtime/store.js";
import { RuntimeClient, RunHandle } from "../src/runtime/client.js";
import { Supervisor, startSupervisor, endpoint as supervisorEndpoint } from "../src/runtime/supervisor.js";
import { ToolGateway } from "../src/runtime/gateway.js";
import { PermissionManager } from "../src/agent/permissions.js";
import { PlanModeManager } from "../src/agent/planMode.js";
import { workspaceState, applyPatch, type WorkspaceHashCache } from "../src/runtime/workspace.js";
import { loadSandboxSettings } from "../src/agent/settings.js";
import { executeTool } from "../src/tools/index.js";
import { runSpawn, readBgOutput } from "../src/tools/process.js";
import { AgentRuntime } from "../src/runtime/runtime.js";

const dirs: string[] = [];
function temp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-review-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("runtime review regressions", () => {
  it("decodes IPC responses split inside a UTF-8 character", async () => {
    const root = temp();
    const endpoint = supervisorEndpoint(root);
    const response = Buffer.from(JSON.stringify({ result: "hello 🌍 বাংলা" }) + "\n");
    const split = response.indexOf(Buffer.from("🌍")) + 1;
    const server = net.createServer((socket) => {
      socket.once("data", () => {
        socket.write(response.subarray(0, split));
        setTimeout(() => socket.end(response.subarray(split)), 20);
      });
    });
    await new Promise<void>((resolve) => server.listen(endpoint, resolve));
    fs.writeFileSync(path.join(root, "connection.json"), JSON.stringify({ endpoint, token: "test" }));
    try {
      expect(await new RuntimeClient(root).request("initialize")).toBe("hello 🌍 বাংলা");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("passes cancellation to a waiting event read", async () => {
    const client = new RuntimeClient(temp());
    const request = vi.spyOn(client, "request").mockImplementation(async (_method, _params, signal) => {
      await new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(new Error("deadline")), { once: true }));
    });
    const controller = new AbortController();
    const pending = new RunHandle(client, "session", "run").events(0, controller.signal).next();
    controller.abort();
    await expect(pending).rejects.toThrow("deadline");
    expect(request.mock.calls[0]?.[2]).toBe(controller.signal);
  });

  it.each(["./private/../private/data", "public/../private/data"])("denies normalized write alias %s", async (alias) => {
    const root = temp();
    fs.mkdirSync(path.join(root, "private"));
    const gateway = new ToolGateway(root, new PermissionManager({ mode: "acceptEdits", deny: ["Write(private/**)"] }), {}, () => {});
    await expect(gateway.execute("write_file", { path: alias, content: "bad" })).rejects.toThrow("Edit permission denied: private/data");
    expect(fs.existsSync(path.join(root, "private/data"))).toBe(false);
  });

  it("reuses content hashes while detecting edits, modes, symlinks, additions and deletions", async () => {
    const root = temp();
    const file = path.join(root, "a");
    fs.writeFileSync(file, "old");
    if (process.platform !== "win32") fs.symlinkSync("a", path.join(root, "link"));
    const cache: WorkspaceHashCache = new Map();
    const original = await workspaceState(root, cache);
    const read = vi.spyOn(fsp, "readFile");
    const link = vi.spyOn(fsp, "readlink");
    expect(await workspaceState(root, cache)).toEqual(original);
    expect(read).not.toHaveBeenCalled();
    expect(link).not.toHaveBeenCalled();
    const before = fs.statSync(file);
    fs.writeFileSync(file, "new");
    fs.utimesSync(file, before.atime, before.mtime);
    fs.chmodSync(file, 0o755);
    if (process.platform !== "win32") {
      fs.unlinkSync(path.join(root, "link"));
      fs.symlinkSync("b", path.join(root, "link"));
    }
    fs.writeFileSync(path.join(root, "b"), "added");
    const edited = await workspaceState(root, cache);
    expect(edited).toEqual(await workspaceState(root));
    expect(edited.files.a).not.toBe(original.files.a);
    if (process.platform !== "win32") expect(edited.files.link).not.toBe(original.files.link);
    fs.unlinkSync(file);
    expect(await workspaceState(root, cache)).toEqual(await workspaceState(root));
    expect(cache.has(file)).toBe(false);
  });

  it("runs configured hooks in plan mode with restricted tools and retains command denies", async () => {
    const root = temp();
    const command = "echo hook-ran";
    const plan = new PlanModeManager();
    plan.enter();
    const run = vi.fn(async () => ({ exitCode: 0, stdout: "hook-ran", stderr: "", combined: "hook-ran" }));
    const emit = vi.fn();
    const context = { planModeManager: plan, commandRunner: { run }, hooks: { Stop: [{ command }] } };
    const gateway = new ToolGateway(root, new PermissionManager({ mode: "plan", allow: ["Bash(echo *)"] }), context, emit, new Set(["read"]));
    await gateway.hooks("Stop", {});
    expect(run).toHaveBeenCalledOnce();
    expect(emit.mock.calls.some(([type]) => type === "hook_result")).toBe(true);
    await expect(gateway.execute("run_command", { command })).rejects.toThrow("not allowed");
    run.mockClear();
    await new ToolGateway(root, new PermissionManager({ mode: "plan", deny: ["Bash(echo *)"] }), context, emit).hooks("Stop", {});
    expect(run).not.toHaveBeenCalled();
    expect(emit.mock.calls.some(([type]) => type === "hook_warning")).toBe(true);
  });

  it("groups delta fsyncs and durably flushes every non-delta event", () => {
    const store = new JournalStore(temp());
    const sync = vi.spyOn(fs, "fsyncSync");
    vi.spyOn(Date, "now").mockReturnValue(1000);
    const append = (type: string) => store.append({ sessionId: "s", runId: "r", agentId: "coordinator", correlationId: "c", type, data: {} });
    append("text_delta");
    sync.mockClear();
    for (const type of ["text_delta", "thinking_delta", "tool_output_delta"]) append(type);
    expect(sync).not.toHaveBeenCalled();
    vi.mocked(Date.now).mockReturnValue(1100);
    append("text_delta");
    expect(sync).toHaveBeenCalledTimes(1);
    for (const type of ["message", "tool_intent", "tool_result", "status", "done"]) append(type);
    expect(sync).toHaveBeenCalledTimes(6);
    expect(new JournalStore(store.root).events("s")).toHaveLength(10);
  });

  it("lists healthy sessions despite invalid identifiers and corrupt snapshots/journals", () => {
    const root = temp();
    const supervisor = new Supervisor(root);
    const valid = supervisor.create(temp());
    const broken = supervisor.create(temp());
    fs.writeFileSync(path.join(root, "sessions", broken.id, "events.jsonl"), "invalid\n");
    fs.mkdirSync(path.join(root, "sessions", "invalid id"));
    fs.mkdirSync(path.join(root, "sessions", "broken"));
    fs.writeFileSync(path.join(root, "sessions", "broken", "snapshot.json"), "{");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(supervisor.store.list().map((s) => s.id)).toEqual([valid.id]);
    expect(warn).toHaveBeenCalledTimes(3);
  });

  it.each(["", "invalid", "0", "-1", "1.5", String(process.pid)])("recovers stale lock PID %j", async (pid) => {
    const root = temp();
    fs.writeFileSync(path.join(root, "supervisor.lock"), pid);
    const kill = vi.spyOn(process, "kill");
    const service = await startSupervisor(root);
    try { expect(kill).not.toHaveBeenCalled(); } finally { await service.close(); }
  });

  it("reclaims a live PID lock when authenticated initialization fails", async () => {
    const root = temp();
    fs.writeFileSync(path.join(root, "supervisor.lock"), "12345");
    vi.spyOn(process, "kill").mockReturnValue(true);
    const request = vi.spyOn(RuntimeClient.prototype, "request").mockRejectedValue(new Error("no response"));
    const service = await startSupervisor(root);
    try { expect(request).toHaveBeenCalledWith("initialize", {}, expect.any(AbortSignal)); } finally { await service.close(); }
  });

  it("retains a live supervisor lock after successful authenticated initialization", async () => {
    const root = temp();
    fs.writeFileSync(path.join(root, "supervisor.lock"), "12345");
    vi.spyOn(process, "kill").mockReturnValue(true);
    vi.spyOn(RuntimeClient.prototype, "request").mockResolvedValue({ version: 1 });
    await expect(startSupervisor(root)).rejects.toThrow("already running");
    expect(fs.readFileSync(path.join(root, "supervisor.lock"), "utf8")).toBe("12345");
  });

  it("refuses a host runner in Docker mode while preserving custom local runners", async () => {
    const run = vi.fn(async () => ({ exitCode: 0, stdout: "ok", stderr: "", combined: "ok" }));
    const root = temp();
    await expect(executeTool(root, "run_command", { command: "echo ok" }, undefined, { sandboxMode: "docker", commandRunner: { run } })).rejects.toThrow("host execution refused");
    expect(run).not.toHaveBeenCalled();
    expect(await executeTool(root, "run_command", { command: "echo ok" }, undefined, { sandboxMode: "local", commandRunner: { run } })).toContain("ok");
  });

  it("accepts network and mounts only from user settings", () => {
    const root = temp(), home = temp();
    for (const dir of [root, home]) fs.mkdirSync(path.join(dir, ".codeagent"));
    for (const file of ["settings.json", "settings.local.json"])
      fs.writeFileSync(path.join(root, ".codeagent", file), JSON.stringify({ sandbox: { mode: "docker", image: "repo-image", network: true, mounts: ["/host:/host"] } }));
    expect(loadSandboxSettings(root, home)).toEqual({ mode: "docker", image: "repo-image" });
    fs.writeFileSync(path.join(home, ".codeagent/settings.json"), JSON.stringify({ sandbox: { network: false, mounts: ["/user:/user"] } }));
    expect(loadSandboxSettings(root, home)).toEqual({ mode: "docker", image: "repo-image", network: false, mounts: ["/user:/user"] });
  });

  it.each([false, true])("survives an early child exit with stdin (background=%s)", async (background) => {
    const result = await runSpawn(temp(), "exit 0", { executable: { file: process.execPath, args: ["-e", "process.exit(0)"] }, background, stdin: "x".repeat(1024 * 1024) });
    if (result.jobId) {
      await vi.waitFor(() => expect(readBgOutput(result.jobId!)).toContain("done"));
    } else expect(result.exitCode).toBe(0);
  });

  it("rejects a patch when git exits before consuming stdin", async () => {
    await expect(applyPatch(temp(), "invalid patch\n".repeat(100000))).rejects.toThrow();
  });

  it.each(["coding", "explore", "plan", "reviewer"])("keeps delegated %s intent tied to its role", async (role) => {
    const runtime = new AgentRuntime({ repoRoot: temp(), model: "test", depth: 1, role, maxIterations: 1, verbose: false, responder: async () => ({ output: [], output_text: "done" }) });
    await runtime.run("What is the weather today?");
    expect((runtime as unknown as { intent: string }).intent).toBe(role === "coding" ? "task" : "inquiry");
  });

  it.each([undefined, "original"])("limits replay to recovery lineage (%s)", async (recoveryRunId) => {
    const root = temp(), home = temp();
    const supervisor = new Supervisor(home);
    const session = supervisor.create(root);
    const base = { sessionId: session.id, agentId: "coordinator", correlationId: "same" };
    for (const [runId, origin] of [["child", "original"], ["grandchild", "child"]])
      supervisor.store.append({ ...base, runId, type: "runtime_origin", data: { origin } });
    for (const runId of ["grandchild", "unrelated"]) {
      supervisor.store.append({ ...base, runId, type: "tool_intent", data: { name: "run_command", args: { command: "echo fresh" } } });
      supervisor.store.append({ ...base, runId, type: "tool_result", data: { output: runId } });
    }
    let turn = 0;
    const runtime = new AgentRuntime({ repoRoot: root, model: "test", maxIterations: 2, autoApprove: true, sessionId: session.id, store: supervisor.store, contextHome: home, recoveryRunId, verbose: false,
      responder: async () => ++turn === 1 ? { output: [{ type: "function_call", name: "run_command", arguments: '{"command":"echo fresh"}', call_id: "same" }], output_text: "" } : { output: [], output_text: "done" } });
    await runtime.run("Run the requested command");
    const messages = supervisor.store.events(session.id).filter((e) => e.runId === runtime.runId && e.type === "message");
    const results = messages.map((e) => e.data.message as { kind: string; text?: string }).filter((m) => m.kind === "result");
    expect(results[0]?.text).toContain(recoveryRunId ? "grandchild" : "fresh");
    expect(results[0]?.text).not.toContain("unrelated");
  });
});
