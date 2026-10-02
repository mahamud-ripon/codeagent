import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { runtimeHome } from "./store.js";
import type { RuntimeEvent, SessionSnapshot } from "./contracts.js";
import type { SessionOptions } from "./supervisor.js";
import type { AgentRunResult } from "../agent/types.js";
export class RuntimeClient {
  constructor(public root = runtimeHome()) {}
  async request<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    const connection = JSON.parse(
      fs.readFileSync(path.join(this.root, "connection.json"), "utf8"),
    ) as { token: string; endpoint: string };
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(connection.endpoint);
      let data = "";
      let settled = false;
      const done = (error?: Error, value?: T) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        error ? reject(error) : resolve(value as T);
      };
      const timer = setTimeout(
        () => done(new Error("Supervisor request timed out")),
        15000,
      );
      socket.on("error", (error) => done(error));
      socket.on("close", () => {
        if (!settled) done(new Error("Supervisor connection closed"));
      });
      socket.on("connect", () =>
        socket.write(
          JSON.stringify({
            id: randomUUID(),
            version: 1,
            token: connection.token,
            method,
            params,
          }) + "\n",
        ),
      );
      socket.on("data", (chunk) => {
        data += String(chunk);
        if (data.length > 64 * 1024 * 1024) {
          done(new Error("IPC response too large"));
          return;
        }
        const i = data.indexOf("\n");
        if (i >= 0) {
          try {
            const r = JSON.parse(data.slice(0, i)) as {
              result: T;
              error?: string;
            };
            done(r.error ? new Error(r.error) : undefined, r.result);
          } catch (e) {
            done(e as Error);
          }
        }
      });
    });
  }
  async ensure(): Promise<void> {
    try {
      await this.request("initialize");
      return;
    } catch {
      /* start */
    }
    // Use the process entrypoint so both the compiled bundle and tsx development work.
    const entry = path.resolve(
      process.argv[1] ?? fileURLToPath(new URL("../index.js", import.meta.url)),
    );
    const runtimeEntry = entry.endsWith("codeagent.bundle.mjs")
      ? entry
      : fileURLToPath(
          new URL(
            import.meta.url.endsWith(".ts") ? "../index.ts" : "../index.js",
            import.meta.url,
          ),
        );
    const child = spawn(
      process.execPath,
      [...process.execArgv, runtimeEntry, "--runtime-supervisor"],
      {
        detached: true,
        stdio: "ignore",
        env: { ...process.env, CODEAGENT_RUNTIME_HOME: this.root },
      },
    );
    child.unref();
    let failure: Error | undefined;
    child.on("error", (e) => (failure = e));
    for (let i = 0; i < 100; i++) {
      if (failure) throw failure;
      try {
        await this.request("initialize");
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    throw new Error("Local supervisor did not become ready");
  }
  async create(
    repoRoot: string,
    options: SessionOptions = {},
  ): Promise<SessionSnapshot> {
    await this.ensure();
    return this.request("create", { repoRoot, options });
  }
  async submit(
    sessionId: string,
    task: string,
    requestId = randomUUID(),
  ): Promise<RunHandle> {
    await this.ensure();
    const run = await this.request<{ runId: string }>("submit", {
      sessionId,
      task,
      requestId,
    });
    return new RunHandle(this, sessionId, run.runId);
  }
  async attach(sessionId: string): Promise<RunHandle> {
    await this.ensure();
    const s = await this.request<SessionSnapshot>("inspect", { sessionId });
    if (!s.runId) throw new Error("Session has no run");
    return new RunHandle(this, sessionId, s.runId);
  }
}
export class RunHandle {
  constructor(
    public client: RuntimeClient,
    public sessionId: string,
    public runId: string,
  ) {}
  async *events(after = 0): AsyncGenerator<RuntimeEvent> {
    for (;;) {
      const events = await this.client.request<RuntimeEvent[]>("events", {
        sessionId: this.sessionId,
        after,
        wait: true,
      });
      for (const e of events) {
        after = e.sequence;
        if (e.runId !== this.runId) continue;
        yield e;
        if (e.type === "done" && e.agentId === "coordinator") return;
      }
    }
  }
  async result(): Promise<AgentRunResult> {
    for await (const e of this.events())
      if (e.type === "done" && e.agentId === "coordinator")
        return e.data as unknown as AgentRunResult;
    throw new Error("Run ended without a result");
  }
  steer(text: string): Promise<unknown> {
    return this.client.request("steer", { sessionId: this.sessionId, text });
  }
  pause(): Promise<unknown> {
    return this.client.request("pause", { sessionId: this.sessionId });
  }
  cancel(): Promise<unknown> {
    return this.client.request("cancel", { sessionId: this.sessionId });
  }
  answer(id: string, answer: string | boolean): Promise<unknown> {
    return this.client.request("answer", {
      sessionId: this.sessionId,
      id,
      answer,
    });
  }
  detach(): { sessionId: string; runId: string } {
    return { sessionId: this.sessionId, runId: this.runId };
  }
}
