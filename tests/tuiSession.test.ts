import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SessionConfig } from "../src/cli/repl.js";

const harness = vi.hoisted(() => ({
  screen: undefined as any,
  runTask: vi.fn(),
  gitStatus: vi.fn(),
  startError: undefined as Error | undefined,
  removeContainer: vi.fn(),
}));
vi.mock("../src/tui/screen.js", () => ({
  TerminalScreen: class {
    options: any;
    entries: Array<{ role: string; text: string }> = [];
    status: any = {};
    pending?: (allowed: boolean) => void;
    stopped = false;
    confirmations: string[] = [];
    questions: string[] = [];
    results: Array<{ text: string; durationMs: number }> = [];
    constructor(options: any) {
      this.options = options;
      harness.screen = this;
    }
    start() {
      if (harness.startError) throw harness.startError;
    }
    stop() {
      this.cancelConfirmation();
      this.stopped = true;
    }
    add(role: string, text: string) {
      this.entries.push({ role, text });
    }
    setStatus(status: any) {
      Object.assign(this.status, status);
    }
    handleEvent() {}
    finish(text: string, durationMs: number) {
      this.results.push({ text, durationMs });
    }
    clear() {
      this.entries = [];
    }
    confirm(title: string) {
      this.confirmations.push(title);
      return new Promise<boolean>((resolve) => {
        this.pending = resolve;
      });
    }
    ask(question: string) {
      this.questions.push(question);
      return Promise.resolve("user answer");
    }
    cancelConfirmation() {
      this.pending?.(false);
      this.pending = undefined;
    }
    answer(allowed: boolean) {
      this.pending?.(allowed);
      this.pending = undefined;
    }
  },
}));
vi.mock("../src/cli/repl.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/cli/repl.js")>()),
  runTask: harness.runTask,
}));
vi.mock("../src/llm/provider.js", () => ({
  describeProviderFromEnv: (_env: unknown, overrides: { model?: string }) => ({
    model: overrides.model ?? "test-model",
  }),
}));
vi.mock("../src/agent/settings.js", () => ({
  loadPermissionSettings: () => ({
    mode: "default",
    allow: [],
    deny: [],
    ask: [],
  }),
  loadHooksSettings: () => ({}),
  loadModelSettings: () => ({}),
  loadSandboxSettings: () => ({}),
}));
vi.mock("../src/agent/hooks.js", () => ({ runHooks: vi.fn() }));
vi.mock("../src/agent/audit.js", () => ({ logAudit: vi.fn() }));
vi.mock("../src/tools/git.js", () => ({
  gitStatus: harness.gitStatus,
  gitDiff: vi.fn(async () => ""),
  isGitRepo: vi.fn(async () => false),
  restoreShadowCheckpoint: vi.fn(async () => false),
}));
vi.mock("../src/tools/sandbox.js", () => ({
  getSandboxMode: () => "local",
  removePersistentContainer: harness.removeContainer,
}));
vi.mock("../src/agent/checkpoint.js", () => ({
  CheckpointManager: class {
    records: any[] = [];
    setCheckpoints(records: any[]) {
      this.records = records;
    }
    listCheckpoints() {
      return this.records;
    }
    async saveCheckpoint() {
      return null;
    }
  },
}));

import { startNextRepl } from "../src/tui/session.js";
import {
  createSession,
  listSessions,
  saveSession,
} from "../src/session/sessionManager.js";

let home: string;
let repoRoot: string;
let lifecycle: Promise<void> | undefined;
const release: Array<() => void> = [];
const submit = (text: string) => harness.screen.options.onSubmit(text);
const idle = () =>
  vi.waitFor(() => expect(harness.screen.status.running).toBe(false));

async function start(config: Partial<SessionConfig> = {}) {
  lifecycle = startNextRepl({
    repoRoot,
    maxIterations: 5,
    sessionHome: home,
    ...config,
  });
  await Promise.resolve();
  return harness.screen;
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "codeagent-tui-session-"));
  repoRoot = path.join(home, "repo");
  fs.mkdirSync(repoRoot);
  vi.clearAllMocks();
  harness.startError = undefined;
  harness.runTask.mockImplementation(async () => {});
  harness.gitStatus.mockResolvedValue("(clean)");
  harness.removeContainer.mockResolvedValue(undefined);
});
afterEach(async () => {
  harness.screen?.options.onExit();
  release.splice(0).forEach((resolve) => resolve());
  await lifecycle?.catch(() => {});
  lifecycle = undefined;
  harness.screen = undefined;
  fs.rmSync(home, { recursive: true, force: true });
});

describe("fullscreen session integration", () => {
  it("executes queued prompts serially and preserves order", async () => {
    let active = 0;
    let maxActive = 0;
    harness.runTask.mockImplementation(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => release.push(resolve));
      active--;
    });
    const screen = await start();
    submit("first");
    submit("second");
    submit("third");
    await vi.waitFor(() => expect(harness.runTask).toHaveBeenCalledTimes(1));
    expect(screen.status.queued).toBe(2);
    release.shift()!();
    await vi.waitFor(() => expect(harness.runTask).toHaveBeenCalledTimes(2));
    release.shift()!();
    await vi.waitFor(() => expect(harness.runTask).toHaveBeenCalledTimes(3));
    release.shift()!();
    await idle();
    expect(harness.runTask.mock.calls.map((call) => call[1])).toEqual([
      "first",
      "second",
      "third",
    ]);
    expect(maxActive).toBe(1);
    expect(screen.status.queued).toBe(0);
  });

  it("cancels the active run and drops queued prompts", async () => {
    harness.runTask.mockImplementation(
      async (_session, _task, signal: AbortSignal) => {
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
      },
    );
    const screen = await start();
    submit("first");
    submit("queued");
    await vi.waitFor(() => expect(harness.runTask).toHaveBeenCalledOnce());
    submit("/cancel");
    await idle();
    expect(harness.runTask.mock.calls[0][2].aborted).toBe(true);
    expect(harness.runTask).toHaveBeenCalledOnce();
    expect(screen.status.queued).toBe(0);
  });

  it("rejects state-changing commands while a turn is running", async () => {
    harness.runTask.mockImplementation(async () => {
      await new Promise<void>((resolve) => release.push(resolve));
    });
    const screen = await start({ model: "original" });
    submit("first");
    await vi.waitFor(() => expect(harness.runTask).toHaveBeenCalledOnce());
    submit("/model changed");
    submit("/new");
    expect(screen.status.model).toBe("original");
    expect(
      screen.entries.filter((entry: any) =>
        entry.text.includes("Wait for the current operation"),
      ),
    ).toHaveLength(2);
    release.shift()!();
    await idle();
  });

  it("denies a pending permission prompt when cancelled", async () => {
    let permitted: boolean | undefined;
    harness.runTask.mockImplementation(async (session: SessionConfig) => {
      permitted = await session.permissions!.checkEdit(
        "src/app.ts",
        "Change app code",
      );
    });
    const screen = await start();
    submit("edit app");
    await vi.waitFor(() => expect(screen.pending).toBeTypeOf("function"));
    screen.options.onCancel();
    await idle();
    expect(permitted).toBe(false);
    expect(screen.pending).toBeUndefined();
  });

  it("serializes parallel permission requests without losing a decision", async () => {
    let decisions: boolean[] = [];
    harness.runTask.mockImplementation(async (session: SessionConfig) => {
      decisions = await Promise.all([
        session.permissions!.checkEdit("first.ts"),
        session.permissions!.checkEdit("second.ts"),
      ]);
    });
    const screen = await start();
    submit("edit two files");
    await vi.waitFor(() => expect(screen.pending).toBeTypeOf("function"));
    expect(screen.confirmations).toHaveLength(1);
    screen.answer(true);
    await vi.waitFor(() => expect(screen.confirmations).toHaveLength(2));
    screen.answer(false);
    await idle();
    expect(decisions).toEqual([true, false]);
  });

  it("exit denies both active and waiting permission requests and cleans up", async () => {
    let decisions: boolean[] = [];
    harness.runTask.mockImplementation(async (session: SessionConfig) => {
      decisions = await Promise.all([
        session.permissions!.checkEdit("first.ts"),
        session.permissions!.checkEdit("second.ts"),
      ]);
    });
    const screen = await start();
    submit("edit two files");
    await vi.waitFor(() => expect(screen.pending).toBeTypeOf("function"));
    screen.options.onExit();
    await lifecycle;
    expect(decisions).toEqual([false, false]);
    expect(screen.confirmations).toHaveLength(1);
    expect(screen.stopped).toBe(true);
  });

  it("rejects late agent questions after cancellation or exit", async () => {
    let ask: ((question: string) => Promise<string>) | undefined;
    harness.runTask.mockImplementation(
      async (_session, _text, signal, _turn, presentation) => {
        ask = presentation.askUser;
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        expect(await ask!("Too late?")).toBe("User cancelled the question.");
      },
    );
    const screen = await start();
    submit("start task");
    await vi.waitFor(() => expect(ask).toBeTypeOf("function"));
    screen.options.onExit();
    await lifecycle;
    expect(screen.questions).toEqual([]);
  });

  it("requires affirmative confirmation to enable bypass permissions", async () => {
    const screen = await start();
    submit("/mode bypass");
    await vi.waitFor(() => expect(screen.pending).toBeTypeOf("function"));
    screen.answer(false);
    await idle();
    expect(screen.status.mode).toBe("default");
    submit("/mode bypass");
    await vi.waitFor(() => expect(screen.pending).toBeTypeOf("function"));
    screen.answer(true);
    await idle();
    expect(screen.status.mode).toBe("bypass");
  });

  it("persists resumed context and refuses sessions from another workspace", async () => {
    const record = createSession(repoRoot, {
      title: "Earlier work",
      model: "resumed-model",
      history: [
        { role: "user", content: "Earlier prompt" },
        {
          type: "message",
          content: [{ type: "output_text", text: "Earlier answer" }],
        },
      ],
    });
    record.usage = { input: 10, output: 20, costUsd: 0.25 };
    saveSession(record, home);
    const foreign = createSession(path.join(home, "other"), {
      title: "Other project",
    });
    saveSession(foreign, home);
    const screen = await start();
    submit(`/resume ${record.id}`);
    await idle();
    expect(screen.status.model).toBe("resumed-model");
    expect(screen.entries).toContainEqual({
      role: "assistant",
      text: "Earlier answer",
    });
    expect(screen.status.costUsd).toBe(0.25);
    submit("continue");
    await vi.waitFor(() => expect(harness.runTask).toHaveBeenCalledOnce());
    await idle();
    expect(harness.runTask.mock.calls[0][0].history).toEqual(record.history);
    submit(`/resume ${foreign.id}`);
    await idle();
    expect(
      screen.entries.some(
        (entry: any) =>
          entry.role === "error" && entry.text.includes("this workspace"),
      ),
    ).toBe(true);
    screen.options.onExit();
    await lifecycle;
    expect(
      listSessions(repoRoot, home).find((saved) => saved.id === record.id)
        ?.history,
    ).toEqual(record.history);
  });

  it("recovers from a command failure and removes handlers on exit", async () => {
    const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
    const before = signals.map((signal) => process.listenerCount(signal));
    const endCount = process.stdin.listenerCount("end");
    harness.gitStatus.mockRejectedValue(new Error("git unavailable"));
    const screen = await start();
    submit("/status");
    await idle();
    expect(
      screen.entries.some(
        (entry: any) =>
          entry.role === "error" && entry.text === "git unavailable",
      ),
    ).toBe(true);
    submit("another task");
    await idle();
    expect(harness.runTask).toHaveBeenCalledOnce();
    screen.options.onExit();
    await lifecycle;
    expect(screen.stopped).toBe(true);
    expect(signals.map((signal) => process.listenerCount(signal))).toEqual(
      before,
    );
    expect(process.stdin.listenerCount("end")).toBe(endCount);
    expect(harness.removeContainer).toHaveBeenCalledOnce();
  });

  it("routes agent questions and completed results through the terminal presentation", async () => {
    let answer: string | undefined;
    harness.runTask.mockImplementation(
      async (_session, _text, _signal, _turn, presentation) => {
        answer = await presentation.askUser("Which package should change?");
        presentation.onResult(
          { finalMessage: "Implementation complete." },
          1250,
        );
      },
    );
    const screen = await start();
    submit("implement change");
    await idle();
    expect(answer).toBe("user answer");
    expect(screen.questions).toEqual(["Which package should change?"]);
    expect(screen.results).toEqual([
      { text: "Implementation complete.", durationMs: 1250 },
    ]);
  });

  it("keeps plan permissions locked on rejection and unlocks only after approval", async () => {
    let decision: boolean | string | undefined;
    harness.runTask.mockImplementation(async (session: SessionConfig) => {
      decision = await session.planApprover!(
        "Change one file and run its tests.",
      );
      // The tool exits PlanModeManager after an affirmative approver response.
      if (decision) {
        session.planModeManager!.exit();
      }
    });
    const screen = await start();
    submit("/plan");
    await idle();
    submit("design a change");
    await vi.waitFor(() => expect(screen.pending).toBeTypeOf("function"));
    screen.answer(false);
    await idle();
    expect(decision).toBe(false);
    expect(screen.status.mode).toBe("plan");
    expect(harness.runTask.mock.calls[0][0].permissions.getMode()).toBe("plan");
    submit("revise the plan");
    await vi.waitFor(() => expect(screen.pending).toBeTypeOf("function"));
    screen.answer(true);
    await idle();
    expect(decision).toBe(true);
    expect(screen.status.mode).toBe("default");
    expect(harness.runTask.mock.calls[1][0].permissions.getMode()).toBe(
      "default",
    );
  });

  it("restores the terminal when startup fails", async () => {
    harness.startError = new Error("terminal unavailable");
    await expect(
      startNextRepl({ repoRoot, maxIterations: 5, sessionHome: home }),
    ).rejects.toThrow("terminal unavailable");
    expect(harness.screen.stopped).toBe(true);
  });
});
