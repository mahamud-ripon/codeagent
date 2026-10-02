import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import os from "node:os";
import {
  randomUUID,
  randomBytes,
  timingSafeEqual,
  createHash,
} from "node:crypto";
import { EventEmitter } from "node:events";
import { z } from "zod";
import { AgentRuntime, type RuntimeOptions } from "./runtime.js";
import { JournalStore, atomicJson, runtimeHome } from "./store.js";
import { PermissionManager } from "../agent/permissions.js";
import {
  loadPermissionSettings,
  loadHooksSettings,
  loadModelSettings,
  loadSandboxSettings,
  consumeSettingsWarnings,
} from "../agent/settings.js";
import {
  fromProvider,
  RunBudget,
  type RuntimeEvent,
  type SessionSnapshot,
} from "./contracts.js";
import { DockerCommandRunner } from "../tools/sandbox.js";
import { listBgJobs } from "../tools/process.js";
import { TaskGraph } from "./tasks.js";

const Options = z.object({
  model: z.string().optional(),
  provider: z.enum(["openai", "chat", "anthropic", "gemini"]).optional(),
  baseURL: z.string().optional(),
  maxIterations: z.number().int().positive().max(10000).default(30),
  autoApprove: z.boolean().default(false),
  allowedTools: z.array(z.string()).default([]),
  sandboxMode: z.enum(["local", "docker"]).optional(),
  maxTotalTokens: z.number().positive().optional(),
  maxCostUsd: z.number().positive().optional(),
  memoryEnabled: z.boolean().optional(),
  compactionThreshold: z.number().min(0.5).max(0.95).default(0.78),
  workerLimit: z.number().int().min(1).max(3).default(3),
});
export type SessionOptions = z.input<typeof Options>;
interface Pending {
  id: string;
  sessionId: string;
  runId: string;
  agentId: string;
  kind: "approval" | "input";
  prompt: string;
  resolve: (answer: string | boolean) => void;
}
interface Running {
  runtime: AgentRuntime;
  controller: AbortController;
  promise: Promise<unknown>;
}
export class Supervisor {
  readonly store: JournalStore;
  readonly notifications = new EventEmitter();
  private running = new Map<string, Running>();
  private pending = new Map<string, Pending>();
  constructor(
    root = runtimeHome(),
    private overrides: Partial<RuntimeOptions> = {},
  ) {
    this.store = new JournalStore(root);
    this.notifications.setMaxListeners(1000);
  }
  private publish(e: RuntimeEvent): void {
    this.notifications.emit(e.sessionId, e);
  }
  create(repoRoot: string, options: SessionOptions = {}): SessionSnapshot {
    if (!fs.statSync(repoRoot).isDirectory())
      throw new Error("Workspace is not a directory");
    const id = randomUUID();
    const record: SessionSnapshot = {
      version: 1,
      id,
      repoRoot: path.resolve(repoRoot),
      sequence: 0,
      status: "paused",
      messages: [],
      tasks: [],
      verifications: [],
    };
    this.store.save(record);
    atomicJson(
      path.join(this.store.directory(id), "options.json"),
      Options.parse(options),
    );
    return record;
  }
  private event(
    id: string,
    type: string,
    data: Record<string, unknown>,
    runId = "",
  ): RuntimeEvent {
    const e = this.store.append({
      sessionId: id,
      runId,
      agentId: "coordinator",
      correlationId: randomUUID(),
      type,
      data,
    });
    this.publish(e);
    return e;
  }
  inspect(id: string): Record<string, unknown> {
    const s = this.store.load(id);
    if (!s) throw new Error("Unknown session");
    return {
      ...s,
      workers: this.store
        .events(id)
        .filter((e) => e.type.startsWith("worker_")),
      jobs: listBgJobs()
        .filter((j) => j.owner?.startsWith(`${id}:`))
        .map(({ proc, ...job }) => job),
      pending: [...this.pending.values()]
        .filter((p) => p.sessionId === id)
        .map(({ resolve, ...p }) => p),
    };
  }
  fork(id: string): SessionSnapshot {
    const source = this.store.load(id);
    if (!source) throw new Error("Unknown session");
    const opts = JSON.parse(
      fs.readFileSync(
        path.join(this.store.directory(id), "options.json"),
        "utf8",
      ),
    );
    const s = this.create(source.repoRoot, opts);
    s.messages = structuredClone(source.messages);
    s.provenance = `fork:${source.id}`;
    this.store.save(s);
    return s;
  }
  importLegacy(file: string): SessionSnapshot {
    const old = JSON.parse(fs.readFileSync(file, "utf8")) as {
      repoRoot?: string;
      history?: unknown[];
      model?: string;
    };
    if (!old.repoRoot || !Array.isArray(old.history))
      throw new Error("Expected a legacy session JSON snapshot");
    const s = this.create(old.repoRoot, { model: old.model });
    s.messages = fromProvider(old.history);
    s.provenance = `legacy:${path.resolve(file)}`;
    this.store.save(s);
    return s;
  }
  async undo(id: string): Promise<string[]> {
    if (this.running.has(id)) throw new Error("Pause the run before undo");
    const s = this.store.load(id);
    if (!s) throw new Error("Unknown session");
    const event = this.store
      .events(id)
      .filter((e) => e.agentId === "coordinator" && e.type === "checkpoint")
      .at(-1);
    if (!event) throw new Error("No checkpoint");
    const { restoreFileCheckpoint } = await import("./workspace.js");
    const checkpoint = JSON.parse(
      fs.readFileSync(
        path.join(String(event.data.directory), "manifest.json"),
        "utf8",
      ),
    );
    const settings = loadPermissionSettings(s.repoRoot);
    const permissions = new PermissionManager({
      ...settings,
      mode: "acceptEdits",
    });
    return restoreFileCheckpoint(checkpoint, async (files) => {
      for (const file of files)
        if (!(await permissions.checkEdit(file, "undo")))
          throw new Error(`Undo denied: ${file}`);
    });
  }
  private waitForInput(
    sessionId: string,
    runId: string,
    agentId: string,
    kind: "approval" | "input",
    prompt: string,
    signal: AbortSignal,
  ): Promise<string | boolean> {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.pending.delete(id);
        reject(new Error("Cancelled"));
      };
      signal.addEventListener("abort", abort, { once: true });
      this.pending.set(id, {
        id,
        sessionId,
        runId,
        agentId,
        kind,
        prompt,
        resolve: (answer) => {
          signal.removeEventListener("abort", abort);
          this.pending.delete(id);
          resolve(answer);
        },
      });
      this.event(
        sessionId,
        "status",
        {
          status:
            kind === "approval" ? "waiting_for_approval" : "waiting_for_input",
        },
        runId,
      );
      this.event(sessionId, `${kind}_request`, { id, agentId, prompt }, runId);
    });
  }
  answer(sessionId: string, id: string, answer: string | boolean): void {
    const p = this.pending.get(id);
    if (!p || p.sessionId !== sessionId)
      throw new Error("No matching pending request");
    if (p.kind === "approval" && typeof answer !== "boolean")
      throw new Error("Approval must be boolean");
    if (p.kind === "input" && typeof answer !== "string")
      throw new Error("Input must be a string");
    this.event(sessionId, `${p.kind}_response`, { id, answer }, p.runId);
    p.resolve(answer);
    this.event(sessionId, "status", { status: "running" }, p.runId);
  }
  submit(
    id: string,
    task: string,
    requestId: string = randomUUID(),
  ): { sessionId: string; runId: string } {
    const previous = this.store
      .events(id)
      .find((e) => e.type === "submission" && e.correlationId === requestId);
    if (previous) {
      if (previous.data.task !== task)
        throw new Error("Request id reused with different content");
      return { sessionId: id, runId: previous.runId };
    }
    if (this.running.has(id))
      throw new Error(
        "Session already running; steer it or fork a new session",
      );
    const snapshot = this.store.load(id);
    if (!snapshot) throw new Error("Unknown session");
    if (!task.trim()) throw new Error("Task is empty");
    const runId = randomUUID();
    const options = Options.parse(
      JSON.parse(
        fs.readFileSync(
          path.join(this.store.directory(id), "options.json"),
          "utf8",
        ),
      ),
    );
    const events = this.store.events(id);
    // Complete interrupted call/result pairs from durable results; never replay side effects.
    const messages = structuredClone(snapshot.messages);
    const results = new Set(
      messages.filter((m) => m.kind === "result").map((m) => m.id),
    );
    for (const m of [...messages])
      if (m.kind === "call" && !results.has(m.id)) {
        const result = events
          .filter(
            (e) =>
              e.type === "tool_result" &&
              e.correlationId === m.id &&
              e.agentId === "coordinator",
          )
          .at(-1);
        messages.push({
          kind: "result",
          id: m.id,
          text: result
            ? String(result.data.output ?? result.data.error)
            : "Execution interrupted; outcome uncertain. Inspect workspace and external state before deciding whether a retry is safe.",
        });
        results.add(m.id);
      }
    const settings = loadPermissionSettings(snapshot.repoRoot);
    const models = loadModelSettings(snapshot.repoRoot);
    const sandbox = loadSandboxSettings(snapshot.repoRoot);
    const previousRunId = snapshot.runId;
    const recovering =
      snapshot.status === "paused" && previousRunId !== undefined;
    const budget = new RunBudget({
      calls: options.maxIterations,
      tokens: options.maxTotalTokens,
      costUsd: options.maxCostUsd,
    });
    if (recovering) {
      const prior = events.filter((e) => e.runId === previousRunId);
      budget.calls = Math.max(
        0,
        ...prior
          .filter((e) => e.type === "model_start")
          .map((e) => Number(e.data.turn)),
      );
      const usage = prior.filter((e) => e.type === "usage").at(-1)?.data;
      if (usage) {
        budget.input = Number(usage.input ?? 0);
        budget.output = Number(usage.output ?? 0);
        budget.cachedInput = Number(usage.cachedInput ?? 0);
        budget.costUsd =
          typeof usage.costUsd === "number" ? usage.costUsd : null;
      }
    }
    const controller = new AbortController();
    const permissions = new PermissionManager({
      mode: options.autoApprove ? "bypass" : settings.mode,
      autoApprove: options.autoApprove,
      allow: [...settings.allow, ...options.allowedTools],
      deny: settings.deny,
      ask: settings.ask,
      handler: async (req) =>
        Boolean(
          await this.waitForInput(
            id,
            runId,
            "coordinator",
            "approval",
            `${req.type}: ${req.target}${req.details ? `\n${req.details}` : ""}`,
            controller.signal,
          ),
        ),
    });
    const tasks = new TaskGraph(snapshot.tasks, (tasks) =>
      this.event(id, "tasks", { tasks }, runId),
    );
    for (const e of events) {
      if (e.type === "mail") {
        const m = e.data.mail as {
          id: string;
          from: string;
          to: string;
          text: string;
        };
        tasks.send(m.from, m.to, m.text, m.id);
      }
      if (e.type === "mail_ack")
        tasks.acknowledge(String(e.data.id), String(e.data.to));
    }
    const runtime = new AgentRuntime({
      ...options,
      ...this.overrides,
      repoRoot: snapshot.repoRoot,
      model:
        options.model ?? models.main ?? process.env.MODEL ?? "gpt-5.6-luna",
      maxIterations: options.maxIterations,
      sessionId: id,
      runId,
      store: this.store,
      tasks,
      permissions,
      budget,
      recoveryRunId: recovering
        ? String(
            events.find(
              (e) => e.runId === previousRunId && e.type === "runtime_origin",
            )?.data.origin ?? previousRunId,
          )
        : undefined,
      allowedTools: undefined,
      hooks: loadHooksSettings(snapshot.repoRoot),
      sandboxMode: options.sandboxMode ?? sandbox.mode,
      commandRunner:
        this.overrides.commandRunner ??
        ((options.sandboxMode ?? sandbox.mode) === "docker"
          ? new DockerCommandRunner(sandbox)
          : undefined),
      contextHome: this.store.root,
      modelRoles: models,
      capabilitiesOverride: models.capabilities,
      onRuntimeEvent: (e) => this.publish(e),
      askUser: async (q) =>
        String(
          await this.waitForInput(
            id,
            runId,
            "coordinator",
            "input",
            q,
            controller.signal,
          ),
        ),
      planApprover: async (p) =>
        Boolean(
          await this.waitForInput(
            id,
            runId,
            "coordinator",
            "approval",
            `Approve implementation plan:\n${p}`,
            controller.signal,
          ),
        ),
    });
    for (const warning of consumeSettingsWarnings())
      this.event(id, "settings_warning", { warning }, runId);
    const submitted = this.store.append({
      sessionId: id,
      runId,
      agentId: "coordinator",
      correlationId: requestId,
      type: "submission",
      data: { task },
    });
    this.publish(submitted);
    snapshot.status = "running";
    snapshot.runId = runId;
    snapshot.messages = messages;
    snapshot.sequence = submitted.sequence;
    this.store.save(snapshot);
    const promise = runtime
      .run(task, {
        signal: controller.signal,
        history: messages.map((m) =>
          m.kind === "text"
            ? { role: m.role, content: m.text }
            : m.kind === "call"
              ? {
                  type: "function_call",
                  call_id: m.id,
                  name: m.name,
                  arguments: m.arguments,
                }
              : m.kind === "result"
                ? {
                    type: "function_call_output",
                    call_id: m.id,
                    output: m.text,
                  }
                : m.payload,
        ),
      })
      .finally(() => this.running.delete(id));
    this.running.set(id, { runtime, controller, promise });
    void promise.catch((error) =>
      this.event(id, "supervisor_error", { error: String(error) }, runId),
    );
    return { sessionId: id, runId };
  }
  steer(id: string, text: string): void {
    const r = this.running.get(id);
    if (!r) throw new Error("Session is not running");
    r.runtime.steer(text);
  }
  pause(id: string): void {
    const r = this.running.get(id);
    if (!r) throw new Error("Session is not running");
    r.runtime.pause();
    r.controller.abort();
  }
  cancel(id: string): void {
    const r = this.running.get(id);
    if (!r) throw new Error("Session is not running");
    r.controller.abort();
  }
  async shutdown(): Promise<void> {
    for (const r of this.running.values()) r.controller.abort();
    await Promise.allSettled([...this.running.values()].map((r) => r.promise));
  }
  recover(): void {
    for (const s of this.store.list())
      if (
        ["running", "waiting_for_approval", "waiting_for_input"].includes(
          s.status,
        )
      ) {
        this.event(
          s.id,
          "recovery",
          {
            message:
              "Supervisor restarted. Resume explicitly; interrupted effects are uncertain and approvals must be requested again.",
          },
          s.runId,
        );
        this.event(s.id, "status", { status: "paused" }, s.runId);
        this.event(
          s.id,
          "tasks",
          {
            tasks: s.tasks.map((t) =>
              t.status === "running"
                ? {
                    ...t,
                    status: "blocked",
                    result: "Worker interrupted; reconcile retained artifacts.",
                  }
                : t,
            ),
          },
          s.runId,
        );
        // A disconnected handle for the interrupted run must terminate too.
        this.event(
          s.id,
          "done",
          {
            status: "paused",
            stopReason: "paused",
            sessionId: s.id,
            runId: s.runId,
            finalMessage:
              "Supervisor restarted. Interrupted actions require reconciliation; submit a continuation to resume.",
            iterations: 0,
            modifiedFiles: [],
            testResults: [],
            costKnown: false,
          },
          s.runId,
        );
      }
  }
}
export function endpoint(root = runtimeHome()): string {
  const key = createHash("sha256")
    .update(root + os.userInfo().username)
    .digest("hex")
    .slice(0, 24);
  return process.platform === "win32"
    ? `\\\\.\\pipe\\codeagent-${key}`
    : path.join(
        os.tmpdir(),
        `codeagent-${process.getuid?.() ?? "user"}-${key}.sock`,
      );
}
export async function startSupervisor(
  root = runtimeHome(),
  overrides: Partial<RuntimeOptions> = {},
): Promise<{
  server: net.Server;
  supervisor: Supervisor;
  close: () => Promise<void>;
}> {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const lock = path.join(root, "supervisor.lock");
  try {
    const fd = fs.openSync(lock, "wx", 0o600);
    fs.writeFileSync(fd, String(process.pid));
    fs.closeSync(fd);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    const pid = Number(fs.readFileSync(lock, "utf8"));
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch (err) {
      alive = (err as NodeJS.ErrnoException).code !== "ESRCH";
    }
    if (alive) throw new Error("Supervisor already running");
    fs.unlinkSync(lock);
    return startSupervisor(root, overrides);
  }
  const token = randomBytes(32).toString("hex");
  atomicJson(path.join(root, "connection.json"), {
    version: 1,
    token,
    endpoint: endpoint(root),
  });
  const supervisor = new Supervisor(root, overrides);
  supervisor.recover();
  if (process.platform !== "win32") fs.rmSync(endpoint(root), { force: true });
  const server = net.createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (buffer.length > 4 * 1024 * 1024) {
        socket.destroy();
        return;
      }
      let index: number;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        void (async () => {
          let requestId: unknown;
          try {
            const req = JSON.parse(line) as {
              id: string;
              version: number;
              token: string;
              method: string;
              params: Record<string, unknown>;
            };
            requestId = req.id;
            if (req.version !== 1)
              throw new Error("Unsupported protocol version");
            const supplied = Buffer.from(req.token ?? "");
            const expected = Buffer.from(token);
            if (
              supplied.length !== expected.length ||
              !timingSafeEqual(supplied, expected)
            )
              throw new Error("Unauthorized IPC client");
            const p = req.params ?? {};
            const id = String(p.sessionId ?? "");
            let result: unknown;
            switch (req.method) {
              case "initialize":
                result = {
                  version: 1,
                  capabilities: [
                    "sessions",
                    "streaming",
                    "approvals",
                    "detach",
                    "tasks",
                    "workers",
                  ],
                };
                break;
              case "create":
                result = supervisor.create(
                  String(p.repoRoot),
                  p.options as SessionOptions,
                );
                break;
              case "list":
                result = supervisor.store.list();
                break;
              case "inspect":
                result = supervisor.inspect(id);
                break;
              case "fork":
                result = supervisor.fork(id);
                break;
              case "undo":
                result = await supervisor.undo(id);
                break;
              case "import":
                result = supervisor.importLegacy(String(p.file));
                break;
              case "submit":
                result = supervisor.submit(
                  id,
                  String(p.task),
                  String(p.requestId ?? randomUUID()),
                );
                break;
              case "steer":
                supervisor.steer(id, String(p.text));
                result = { ok: true };
                break;
              case "pause":
                supervisor.pause(id);
                result = { ok: true };
                break;
              case "cancel":
                supervisor.cancel(id);
                result = { ok: true };
                break;
              case "answer":
                supervisor.answer(
                  id,
                  String(p.id),
                  p.answer as string | boolean,
                );
                result = { ok: true };
                break;
              case "events": {
                const after = Number(p.after ?? 0);
                if (!Number.isInteger(after) || after < 0)
                  throw new Error("Invalid event cursor");
                let events = supervisor.store.events(id, after);
                if (!events.length && p.wait) {
                  await new Promise<void>((resolve) => {
                    const finish = () => {
                      clearTimeout(timer);
                      supervisor.notifications.off(id, finish);
                      socket.off("close", finish);
                      resolve();
                    };
                    const timer = setTimeout(finish, 1000);
                    supervisor.notifications.once(id, finish);
                    socket.once("close", finish);
                  });
                  events = supervisor.store.events(id, after);
                }
                result = events;
                break;
              }
              default:
                throw new Error("Unknown supervisor method");
            }
            if (!socket.destroyed)
              socket.write(JSON.stringify({ id: requestId, result }) + "\n");
          } catch (e) {
            if (!socket.destroyed)
              socket.write(
                JSON.stringify({
                  id: requestId,
                  error: e instanceof Error ? e.message : String(e),
                }) + "\n",
              );
          }
        })();
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint(root), resolve);
  });
  if (process.platform !== "win32") fs.chmodSync(endpoint(root), 0o600);
  return {
    server,
    supervisor,
    close: async () => {
      await supervisor.shutdown();
      await new Promise<void>((r) => server.close(() => r()));
      fs.rmSync(lock, { force: true });
      fs.rmSync(path.join(root, "connection.json"), { force: true });
    },
  };
}
