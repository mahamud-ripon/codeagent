import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { JournalStore, StreamingRedactor } from "../src/runtime/store.js";
import { TaskGraph } from "../src/runtime/tasks.js";
import { AgentRuntime } from "../src/runtime/runtime.js";
import { RunBudget, type RuntimeEvent } from "../src/runtime/contracts.js";
import {
  workspaceState,
  VerificationLedger,
  WorktreeCoordinator,
  git,
} from "../src/runtime/workspace.js";
import { ToolGateway } from "../src/runtime/gateway.js";
import { PermissionManager } from "../src/agent/permissions.js";
import { Supervisor, startSupervisor } from "../src/runtime/supervisor.js";
import { RuntimeClient } from "../src/runtime/client.js";
import { compactMessages, ProjectMemory } from "../src/runtime/context.js";
import { DockerCommandRunner } from "../src/tools/sandbox.js";
const dirs: string[] = [];
// These tests launch many real Git processes; Windows runners need more than 5s.
const GIT_INTEGRATION_TIMEOUT = 30_000;
async function temp() {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), "codeagent-runtime-"));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  // Remove worktrees before their repositories, allowing transient Windows locks to clear.
  for (const d of dirs.splice(0).reverse())
    await fs.rm(d, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
}, GIT_INTEGRATION_TIMEOUT);
const call = (name: string, args: unknown, id = randomUUID()) => ({
  output: [
    {
      type: "function_call",
      name,
      arguments: JSON.stringify(args),
      call_id: id,
    },
  ],
  output_text: "",
});
const done = (text = "done") => ({ output: [], output_text: text });

describe("durable runtime", () => {
  it("redacts credentials split across streamed chunks", () => {
    const redactor = new StreamingRedactor();
    const output =
      [
        "Using sk-",
        "abcdefghijklmnopqrstuvwxyz",
        " now.\nAuthorization: Bear",
        "er opaque-value\n",
      ]
        .map((s) => redactor.push(s))
        .join("") + redactor.push("", true);
    expect(output).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(output).not.toContain("opaque-value");
    expect(output).toContain("[REDACTED]");
  });
  it("ignores a valid JSON tail without its commit newline", async () => {
    const store = new JournalStore(await temp());
    const id = randomUUID();
    const event = {
      sessionId: id,
      runId: "r",
      agentId: "coordinator",
      correlationId: "c",
      type: "status",
      data: { status: "running" },
    };
    const first = store.append(event);
    await fs.appendFile(
      path.join(store.directory(id), "events.jsonl"),
      JSON.stringify({ ...first, sequence: 2 }),
    );
    expect(store.events(id)).toHaveLength(1);
    expect(store.append(event).sequence).toBe(2);
    expect(new JournalStore(store.root).events(id)).toHaveLength(2);
  });

  it("repairs only a partial journal tail and preserves sequence", async () => {
    const store = new JournalStore(await temp());
    const id = randomUUID();
    const e = {
      sessionId: id,
      runId: "run",
      agentId: "coordinator",
      correlationId: "c",
      type: "status",
      data: { status: "running" },
    };
    store.append(e);
    await fs.appendFile(
      path.join(store.directory(id), "events.jsonl"),
      '{"partial":',
    );
    expect(store.events(id)).toHaveLength(1);
    expect(store.append(e).sequence).toBe(2);
    expect(store.events(id)).toHaveLength(2);
  });
  it("rejects corrupt completed records instead of discarding history", async () => {
    const store = new JournalStore(await temp());
    const id = randomUUID();
    await fs.writeFile(
      path.join(store.directory(id), "events.jsonl"),
      "invalid\n",
    );
    expect(() => store.events(id)).toThrow("Corrupt");
  });
  it("replays coordinator state without replacing it with child completion", async () => {
    const s = new Supervisor(await temp());
    const session = s.create(await temp());
    s.store.append({
      sessionId: session.id,
      runId: "r",
      agentId: "child",
      correlationId: "c",
      type: "done",
      data: { status: "completed" },
    });
    expect(s.store.load(session.id)?.status).toBe("paused");
  });
  it("rejects path traversal in session ids", async () => {
    const store = new JournalStore(await temp());
    expect(() => store.events("../outside")).toThrow();
  });
  it("claims tasks atomically and rejects dependency cycles", () => {
    const t = {
      id: "a",
      objective: "a",
      acceptance: ["works"],
      dependencies: [],
      artifacts: [],
      status: "pending" as const,
    };
    const g = new TaskGraph([t]);
    g.claim("a", "one");
    expect(() => g.claim("a", "two")).toThrow();
    expect(() => g.finish("a", "two", "completed", "ok")).toThrow();
    expect(() => g.replace([{ ...t, dependencies: ["a"] }])).toThrow("cycle");
  });
  it("deduplicates mail and checks acknowledgement ownership", () => {
    const g = new TaskGraph();
    g.send("a", "b", "hello", "m");
    g.send("a", "b", "hello", "m");
    expect(g.inbox("b")).toHaveLength(1);
    expect(() => g.acknowledge("m", "c")).toThrow();
    g.acknowledge("m", "b");
    expect(g.inbox("b")).toEqual([]);
  });
  it("shares a finite budget and treats unknown prices as unknown", () => {
    const b = new RunBudget({ calls: 1 });
    b.reserve();
    expect(() => b.reserve()).toThrow();
    b.add({ input: 2, output: 1 });
    expect(b.costUsd).toBeNull();
  });
  it("invalidates verification on content drift and failed rechecks", async () => {
    const root = await temp();
    await fs.writeFile(path.join(root, "a"), "one");
    const a = await workspaceState(root);
    const ledger = new VerificationLedger();
    ledger.record("test", 0, "ok", a.hash);
    expect(ledger.missing(["test"], a.hash)).toEqual([]);
    await fs.writeFile(path.join(root, "a"), "two");
    expect(ledger.missing(["test"], (await workspaceState(root)).hash)).toEqual(
      ["test"],
    );
    ledger.record("test", 1, "bad", a.hash);
    expect(ledger.missing(["test"], a.hash)).toEqual(["test"]);
  });
  it("blocks edits and shell commands in plan mode including permissive child lists", async () => {
    const root = await temp();
    const gateway = new ToolGateway(
      root,
      new PermissionManager({ mode: "plan" }),
      {},
      () => {},
      new Set(["write_file", "run_command"]),
    );
    await expect(
      gateway.execute("write_file", { path: "a", content: "x" }),
    ).rejects.toThrow("Plan mode");
    await expect(
      gateway.execute("run_command", { command: "echo x" }),
    ).rejects.toThrow("Plan mode");
  });
  it("blocks symlink escapes before a write", async () => {
    if (process.platform === "win32") return;
    const root = await temp(),
      outside = await temp();
    await fs.symlink(outside, path.join(root, "link"));
    const g = new ToolGateway(
      root,
      new PermissionManager({ autoApprove: true }),
      {},
      () => {},
    );
    await expect(
      g.execute("write_file", { path: "link/a", content: "x" }),
    ).rejects.toThrow("symlink");
  });
  it("does not execute on the host when Docker is unavailable", async () => {
    let invoked = false;
    const d = new DockerCommandRunner({
      fallbackRunner: {
        run: async () => {
          invoked = true;
          throw new Error("host");
        },
      },
    });
    d.isDockerAvailable = async () => false;
    await expect(d.run(await temp(), "echo x")).rejects.toThrow("Docker");
    expect(invoked).toBe(false);
  });
  it("uses the same permission path for worker tools", async () => {
    const root = await temp();
    let n = 0;
    const r = new AgentRuntime({
      repoRoot: root,
      model: "test",
      maxIterations: 3,
      allowedTools: ["read"],
      responder: async () =>
        ++n === 1 ? call("write_file", { path: "a", content: "bad" }) : done(),
      verbose: false,
    });
    const result = await r.run("Investigate a change");
    expect(
      result.history?.some(
        (m: any) =>
          m.type === "function_call_output" && m.output.includes("not allowed"),
      ),
    ).toBe(true);
    await expect(fs.access(path.join(root, "a"))).rejects.toThrow();
  });
  it("emits exactly one terminal event with an injected provider and no API key", async () => {
    const events: RuntimeEvent[] = [];
    const root = await temp();
    const r = new AgentRuntime({
      repoRoot: root,
      model: "test",
      maxIterations: 2,
      responder: async () => done("answer"),
      onRuntimeEvent: (e) => events.push(e),
      verbose: false,
    });
    expect((await r.run("Explain this repository")).stopReason).toBe("ok");
    expect(events.filter((e) => e.type === "done")).toHaveLength(1);
  });
  it("cannot claim completion after changes without required verification", async () => {
    const root = await temp();
    await fs.writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ scripts: { test: "node test.cjs" } }),
    );
    let n = 0;
    const r = new AgentRuntime({
      repoRoot: root,
      model: "test",
      maxIterations: 5,
      autoApprove: true,
      responder: async () =>
        ++n === 1
          ? call("write_file", { path: "new.txt", content: "change" })
          : done("all good"),
      verbose: false,
    });
    const result = await r.run("Implement a new file");
    expect(result.status).toBe("blocked");
    expect(result.finalMessage).toContain("Required verification");
  });
  it("records real checks and allows verified changes to complete", async () => {
    const root = await temp();
    await fs.writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ scripts: { test: "node test.cjs" } }),
    );
    await fs.writeFile(
      path.join(root, "test.cjs"),
      'require("node:assert").equal(require("node:fs").readFileSync("new.txt","utf8"),"change");',
    );
    let n = 0;
    const r = new AgentRuntime({
      repoRoot: root,
      model: "test",
      maxIterations: 5,
      autoApprove: true,
      responder: async () =>
        ++n === 1
          ? call("write_file", { path: "new.txt", content: "change" })
          : n === 2
            ? call("verify", { command: "npm run test" })
            : done(),
      verbose: false,
    });
    const result = await r.run("Implement a new file");
    expect(result.status).toBe("completed");
    expect(result.testResults[0]?.exitCode).toBe(0);
  });
  it("preserves budget limits when a model never concludes", async () => {
    const root = await temp();
    const r = new AgentRuntime({
      repoRoot: root,
      model: "test",
      maxIterations: 2,
      responder: async () => call("list_files", {}),
      verbose: false,
    });
    expect((await r.run("Inspect the project")).stopReason).toBe("budget");
  });
  it("does not let arbitrary exit-zero commands stand in for tests", async () => {
    const root = await temp();
    const g = new ToolGateway(
      root,
      new PermissionManager({ autoApprove: true }),
      {
        runtimeTool: async () => {
          throw new Error("Not a discovered check");
        },
      },
      () => {},
    );
    await expect(g.execute("verify", { command: "echo ok" })).rejects.toThrow(
      "discovered",
    );
  });
  it("keeps generated memory scoped to a project and supports disabling/deleting", async () => {
    const home = await temp(),
      a = await temp(),
      b = await temp();
    const m = new ProjectMemory(a, true, home);
    const e = m.add("uses npm", "test");
    expect(new ProjectMemory(b, true, home).list()).toEqual([]);
    expect(new ProjectMemory(a, false, home).list()).toEqual([]);
    m.remove(e.id);
    expect(m.list()).toEqual([]);
  });
  it("keeps project skills within their configured directory and read scope", async () => {
    const { loadSkills } = await import("../src/agent/skills.js");
    const root = await temp(),
      home = await temp(),
      outside = await temp();
    const skill = path.join(root, ".codeagent", "skills", "allowed");
    await fs.mkdir(skill, { recursive: true });
    await fs.writeFile(
      path.join(skill, "SKILL.md"),
      "description: local\nUse the local API",
    );
    await fs.writeFile(
      path.join(outside, "SKILL.md"),
      "description: foreign\nPrivate project instructions",
    );
    await fs.symlink(
      outside,
      path.join(root, ".codeagent", "skills", "escape"),
      "junction",
    );
    expect((await loadSkills(root, home)).map((s) => s.name)).toEqual([
      "allowed",
    ]);
    expect(await loadSkills(root, home, () => false)).toEqual([]);
  });
  it("retains pinned requirements through compaction", async () => {
    const messages: any[] = [
      { kind: "text", role: "system", text: "rules" },
      {
        kind: "text",
        role: "system",
        text: "Repository constraint: preserve the public API",
      },
      { kind: "text", role: "user", text: "Do not change the database schema" },
      ...Array.from({ length: 30 }, (_, i) => ({
        kind: "text",
        role: "assistant",
        text: `${i} ${"x".repeat(600)}`,
      })),
    ];
    const out = await compactMessages(messages, {
      window: 6000,
      outputReserve: 1000,
      pinned: "Keep API compatible; task pending",
      sessionId: "s",
      summarizer: async () => done("Summary"),
    });
    expect(JSON.stringify(out)).toContain("Keep API compatible");
    expect(JSON.stringify(out)).toContain(
      "Repository constraint: preserve the public API",
    );
    expect(JSON.stringify(out)).toContain("Do not change the database schema");
    const twice = await compactMessages([...out, ...messages.slice(3)], {
      window: 6000,
      outputReserve: 1000,
      pinned: "task pending",
      sessionId: "s",
      summarizer: async () => done("Another summary"),
    });
    expect(JSON.stringify(twice)).toContain(
      "Do not change the database schema",
    );
    expect(JSON.stringify(twice)).toContain(
      "Repository constraint: preserve the public API",
    );
  });
  it("continues after client disconnect, replays results and deduplicates submit", async () => {
    const home = await temp(),
      root = await temp();
    let n = 0;
    const service = await startSupervisor(home, {
      responder: async () => {
        n++;
        return done("detached answer");
      },
      verbose: false,
    });
    try {
      const c = new RuntimeClient(home);
      const session = await c.create(root, { model: "test" });
      const h = await c.submit(session.id, "Explain the project", "request");
      const again = await c.submit(
        session.id,
        "Explain the project",
        "request",
      );
      expect(again.runId).toBe(h.runId);
      const result = await h.result();
      expect(result.finalMessage).toBe("detached answer");
      const reattached = await new RuntimeClient(home).attach(session.id);
      expect((await reattached.result()).status).toBe("completed");
      expect(n).toBe(2);
    } finally {
      await service.close();
    }
  });
  it("persists pending approval until the matching request is answered", async () => {
    const home = await temp(),
      root = await temp();
    let n = 0;
    const s = new Supervisor(home, {
      responder: async () =>
        ++n === 1 ? call("run_command", { command: "echo hello" }) : done(),
      verbose: false,
    });
    const session = s.create(root, { model: "test" });
    s.submit(session.id, "Run the command");
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("No approval")), 3000);
        s.notifications.on(session.id, (e: RuntimeEvent) => {
          if (e.type === "approval_request") {
            expect(() => s.answer("wrong", String(e.data.id), true)).toThrow();
            s.answer(session.id, String(e.data.id), true);
            clearTimeout(timer);
            resolve();
          }
        });
      });
    } finally {
      await s.shutdown();
    }
  });
  it("forks history without execution identities or approvals", async () => {
    const s = new Supervisor(await temp());
    const a = s.create(await temp());
    a.messages = [{ kind: "text", role: "user", text: "goal" }];
    s.store.save(a);
    const b = s.fork(a.id);
    expect(b.id).not.toBe(a.id);
    expect(b.runId).toBeUndefined();
    expect(b.messages).toEqual(a.messages);
    expect(b.tasks).toEqual([]);
  });
});

describe("worker integration", { timeout: GIT_INTEGRATION_TIMEOUT }, () => {
  async function repo() {
    const root = await temp();
    await git(root, ["init"]);
    // Fixtures write LF bytes explicitly, independent of the runner's Git defaults.
    await git(root, ["config", "core.autocrlf", "false"]);
    await git(root, ["config", "core.eol", "lf"]);
    await fs.writeFile(path.join(root, "a.txt"), "base\n");
    await git(root, ["add", "."]);
    await git(root, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-m",
      "base",
    ]);
    return root;
  }
  it("refuses integration if verification changes the tested files", async () => {
    const root = await repo();
    const c = new WorktreeCoordinator(root, await temp());
    const worker = await c.create("w");
    await fs.writeFile(path.join(worker, "a.txt"), "worker\n");
    await expect(
      c.integrate(
        "w",
        async () => {},
        async (root) => {
          await fs.writeFile(path.join(root, "a.txt"), "test mutation\n");
        },
      ),
    ).rejects.toThrow("Verification changed");
    expect(await fs.readFile(path.join(root, "a.txt"), "utf8")).toBe("base\n");
  });
  it("does not execute Git hooks or clean/smudge filters during isolation", async () => {
    const root = await repo();
    const marker = path.join(root, "unexpected-hook").replace(/\\/g, "/");
    await fs.writeFile(
      path.join(root, ".git", "hooks", "post-checkout"),
      `#!/bin/sh\necho hook > '${marker}'\n`,
      { mode: 0o755 },
    );
    await fs.writeFile(
      path.join(root, ".gitattributes"),
      "*.txt filter=unsafe\n",
    );
    await git(root, [
      "config",
      "filter.unsafe.clean",
      `echo filter > '${marker}'`,
    ]);
    await git(root, [
      "config",
      "filter.unsafe.smudge",
      `echo filter > '${marker}'`,
    ]);
    const c = new WorktreeCoordinator(root, await temp());
    await c.create("isolated");
    await expect(fs.access(marker)).rejects.toThrow();
  });
  it("excludes denied file content from Git diffs", async () => {
    const root = await repo();
    await fs.writeFile(path.join(root, "a.txt"), "private changed content\n");
    const gateway = new ToolGateway(
      root,
      new PermissionManager({ deny: ["Read(a.txt)"] }),
      {},
      () => {},
    );
    expect(await gateway.execute("git_diff", {})).not.toContain(
      "private changed content",
    );
  });
  it("carries dirty and untracked files into workers without changing the user index", async () => {
    const root = await repo();
    await fs.writeFile(path.join(root, "a.txt"), "dirty\n");
    await fs.writeFile(path.join(root, "local.txt"), "local\n");
    const index = await git(root, ["diff", "--cached"]);
    const c = new WorktreeCoordinator(root, await temp());
    const worker = await c.create("one");
    expect(await fs.readFile(path.join(worker, "a.txt"), "utf8")).toBe(
      "dirty\n",
    );
    expect(await fs.readFile(path.join(worker, "local.txt"), "utf8")).toBe(
      "local\n",
    );
    expect(await git(root, ["diff", "--cached"])).toBe(index);
  });
  it("serializes integration and verifies combined results before applying", async () => {
    const root = await repo();
    const c = new WorktreeCoordinator(root, await temp());
    const [a, b] = await Promise.all([c.create("a"), c.create("b")]);
    await fs.writeFile(path.join(a, "one.txt"), "one");
    await fs.writeFile(path.join(b, "two.txt"), "two");
    let checks = 0;
    await c.integrate(
      "a",
      async () => {},
      async () => {
        checks++;
      },
    );
    await c.integrate(
      "b",
      async () => {},
      async (dir) => {
        expect(await fs.readFile(path.join(dir, "one.txt"), "utf8")).toBe(
          "one",
        );
        checks++;
      },
    );
    expect(checks).toBe(2);
    expect(await fs.readFile(path.join(root, "two.txt"), "utf8")).toBe("two");
  });
  it("preserves user edits if destination drifts during verification", async () => {
    const root = await repo();
    const c = new WorktreeCoordinator(root, await temp());
    const w = await c.create("w");
    await fs.writeFile(path.join(w, "a.txt"), "worker\n");
    await expect(
      c.integrate(
        "w",
        async () => {},
        async () => {
          await fs.writeFile(path.join(root, "a.txt"), "user\n");
        },
      ),
    ).rejects.toThrow("Destination changed");
    expect(await fs.readFile(path.join(root, "a.txt"), "utf8")).toBe("user\n");
  });
  it("retains conflicting work instead of applying it", async () => {
    const root = await repo();
    const c = new WorktreeCoordinator(root, await temp());
    const a = await c.create("a"),
      b = await c.create("b");
    await fs.writeFile(path.join(a, "a.txt"), "one\n");
    await fs.writeFile(path.join(b, "a.txt"), "two\n");
    await c.integrate(
      "a",
      async () => {},
      async () => {},
    );
    await expect(
      c.integrate(
        "b",
        async () => {},
        async () => {},
      ),
    ).rejects.toThrow("conflict");
    expect(await fs.readFile(path.join(root, "a.txt"), "utf8")).toBe("one\n");
    expect(await fs.readFile(path.join(b, "a.txt"), "utf8")).toBe("two\n");
  });
});

describe("recovery and checkpoints", () => {
  it("records an interrupted mutation as uncertain without repeating it", async () => {
    const home = await temp(),
      root = await temp();
    const s = new Supervisor(home, {
      responder: async () => done("Inspected recovery"),
      verbose: false,
    });
    const session = s.create(root, { model: "test" });
    session.status = "running";
    session.runId = "old";
    session.messages = [
      {
        kind: "call",
        id: "call",
        name: "run_command",
        arguments: '{"command":"echo effect"}',
      },
    ];
    s.store.save(session);
    s.store.append({
      sessionId: session.id,
      runId: "old",
      agentId: "coordinator",
      correlationId: "call",
      type: "tool_intent",
      data: {
        name: "run_command",
        args: { command: "echo effect" },
        recovery: "reconcile",
      },
    });
    s.recover();
    expect(s.store.load(session.id)?.status).toBe("paused");
    s.submit(session.id, "Continue after inspecting the interruption");
    await new Promise<void>((resolve) =>
      s.notifications.on(session.id, (e: RuntimeEvent) => {
        if (e.type === "done") resolve();
      }),
    );
    const replay = s.store.load(session.id)!;
    expect(JSON.stringify(replay.messages)).toContain("outcome uncertain");
    expect(
      s.store.events(session.id).filter((e) => e.type === "tool_intent"),
    ).toHaveLength(1);
    await s.shutdown();
  });
  it("retains the original verification baseline across resumed edits", async () => {
    const root = await temp(),
      home = await temp();
    const supervisor = new Supervisor(home);
    const session = supervisor.create(root);
    const before = await workspaceState(root);
    supervisor.store.append({
      sessionId: session.id,
      runId: "original",
      agentId: "coordinator",
      correlationId: "start",
      type: "workspace_start",
      data: { state: before },
    });
    await fs.writeFile(path.join(root, "changed.txt"), "changed before crash");
    const runtime = new AgentRuntime({
      repoRoot: root,
      model: "test",
      maxIterations: 5,
      sessionId: session.id,
      recoveryRunId: "original",
      contextHome: home,
      store: supervisor.store,
      responder: async () => done("Everything is complete"),
      verbose: false,
    });
    const result = await runtime.run("Resume implementing the feature");
    expect(result.status).toBe("blocked");
    expect(result.modifiedFiles).toContain("changed.txt");
    expect(result.finalMessage).toContain("verification command");
  });
  it("does not repeat a completed mutating call id", async () => {
    const root = await temp();
    let n = 0;
    const r = new AgentRuntime({
      repoRoot: root,
      model: "test",
      maxIterations: 3,
      autoApprove: true,
      responder: async () =>
        ++n <= 2
          ? call(
              "run_command",
              {
                command:
                  "node -e \"require('fs').appendFileSync('count','x')\"",
              },
              "same",
            )
          : done(),
      verbose: false,
    });
    await r.run("Run the operation");
    expect(await fs.readFile(path.join(root, "count"), "utf8")).toBe("x");
  });
  it("restores changed and created files without Git and refuses user drift", async () => {
    const {
      createFileCheckpoint,
      finishFileCheckpoint,
      restoreFileCheckpoint,
    } = await import("../src/runtime/workspace.js");
    const root = await temp();
    await fs.writeFile(path.join(root, "a"), "before");
    const c = await createFileCheckpoint(root, await temp());
    await fs.writeFile(path.join(root, "a"), "agent");
    await fs.writeFile(path.join(root, "new"), "new");
    await finishFileCheckpoint(c);
    await fs.writeFile(path.join(root, "a"), "user");
    await expect(restoreFileCheckpoint(c, async () => {})).rejects.toThrow(
      "User changes",
    );
    await fs.writeFile(path.join(root, "a"), "agent");
    await restoreFileCheckpoint(c, async () => {});
    expect(await fs.readFile(path.join(root, "a"), "utf8")).toBe("before");
    await expect(fs.access(path.join(root, "new"))).rejects.toThrow();
  });
  it("reloads worktree manifests and integrates retained results", async () => {
    const root = await temp(),
      dir = await temp();
    await git(root, ["init"]);
    await fs.writeFile(path.join(root, "a"), "before");
    await git(root, ["add", "."]);
    await git(root, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-m",
      "initial",
    ]);
    const c = new WorktreeCoordinator(root, dir);
    const w = await c.create("saved");
    await fs.writeFile(path.join(w, "a"), "after");
    const restored = new WorktreeCoordinator(root, dir);
    await restored.restore();
    await restored.integrate(
      "saved",
      async () => {},
      async () => {},
    );
    expect(await fs.readFile(path.join(root, "a"), "utf8")).toBe("after");
  }, GIT_INTEGRATION_TIMEOUT);
  it("enforcement hooks fail closed while advisory hooks cannot deny", async () => {
    const root = await temp();
    const command =
      "node -e \"console.log(JSON.stringify({decision:'deny'}))\"";
    const make = (enforcement: boolean) =>
      new ToolGateway(
        root,
        new PermissionManager({ autoApprove: true }),
        { hooks: { PreToolUse: [{ command, enforcement }] } },
        () => {},
      );
    await expect(
      make(true).execute("write_file", { path: "a", content: "x" }),
    ).rejects.toThrow("denied");
    await expect(fs.access(path.join(root, "a"))).rejects.toThrow();
    await make(false).execute("write_file", { path: "a", content: "x" });
    expect(await fs.readFile(path.join(root, "a"), "utf8")).toBe("x");
  });
  it("rejects an unsupported settings version", async () => {
    const root = await temp();
    await fs.mkdir(path.join(root, ".codeagent"));
    await fs.writeFile(
      path.join(root, ".codeagent/settings.json"),
      '{"schemaVersion":99}',
    );
    const { loadPermissionSettings } = await import("../src/agent/settings.js");
    expect(() => loadPermissionSettings(root, root)).toThrow("schemaVersion");
  });
});

it("enforces denied read paths through search, listing, and normalized aliases", async () => {
  const root = await temp();
  await fs.mkdir(path.join(root, "private"));
  await fs.writeFile(path.join(root, "private", "data.txt"), "secret-marker");
  await fs.writeFile(path.join(root, "public.txt"), "public-marker");
  const g = new ToolGateway(
    root,
    new PermissionManager({ deny: ["Read(private/**)"] }),
    {},
    () => {},
  );
  await expect(
    g.execute("read", { path: "./private/../private/data.txt" }),
  ).rejects.toThrow("denied");
  expect(await g.execute("grep", { query: "secret-marker" })).not.toContain(
    "secret-marker",
  );
  expect(await g.execute("list_files", {})).not.toContain("private/data");
  expect(await g.execute("glob", { pattern: "**" })).not.toContain(
    "private/data",
  );
});
