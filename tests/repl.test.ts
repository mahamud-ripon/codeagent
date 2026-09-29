import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  detectEndpointForKey,
  handleSessionCommand,
  isSensitiveLine,
  parseSlashCommand,
  saveApiKeyToEnvFile,
  type SessionConfig,
} from "../src/cli/repl.js";
import {
  createSession,
  loadSession,
  saveSession,
} from "../src/session/sessionManager.js";
import { createProviderFromEnv, describeProviderFromEnv } from "../src/llm/provider.js";

describe("parseSlashCommand", () => {
  it("returns null for plain tasks", () => {
    expect(parseSlashCommand("Fix the failing test")).toBeNull();
    expect(parseSlashCommand("")).toBeNull();
  });

  it("parses bare commands", () => {
    expect(parseSlashCommand("/help")).toEqual({ cmd: "help", args: "" });
    expect(parseSlashCommand("/EXIT")).toEqual({ cmd: "exit", args: "" });
  });

  it("splits command and args", () => {
    expect(parseSlashCommand("/model openai/gpt-oss-20b")).toEqual({
      cmd: "model",
      args: "openai/gpt-oss-20b",
    });
    expect(parseSlashCommand("/repo  ./my-app ")).toEqual({ cmd: "repo", args: "./my-app" });
  });
});

describe("detectEndpointForKey", () => {
  it("maps known key prefixes to endpoints", () => {
    expect(detectEndpointForKey("gsk_abc")).toMatchObject({ label: "Groq" });
    expect(detectEndpointForKey("AIzaXYZ")).toMatchObject({ label: "Gemini" });
    expect(detectEndpointForKey("sk-or-123")).toMatchObject({ label: "OpenRouter" });
  });

  it("returns null for unknown keys (e.g. OpenAI)", () => {
    expect(detectEndpointForKey("sk-proj-xyz")).toBeNull();
  });
});

describe("provider overrides (REPL session switching)", () => {
  it("model override wins over env", () => {
    const { info } = createProviderFromEnv(
      { OPENAI_API_KEY: "k", MODEL: "env-model" } as NodeJS.ProcessEnv,
      { model: "session-model" },
    );
    expect(info.model).toBe("session-model");
  });

  it("baseURL override implies chat", () => {
    const { info } = createProviderFromEnv({ OPENAI_API_KEY: "k" } as NodeJS.ProcessEnv, {
      baseURL: "http://localhost:11434/v1",
      model: "qwen2.5-coder:7b",
    });
    expect(info).toMatchObject({ kind: "openai-chat", baseURL: "http://localhost:11434/v1" });
  });

  it("provider override forces chat without a baseURL", () => {
    const { info } = createProviderFromEnv({ OPENAI_API_KEY: "k" } as NodeJS.ProcessEnv, {
      provider: "chat",
      model: "x",
    });
    expect(info.kind).toBe("openai-chat");
  });
});

describe("describeProviderFromEnv (no key required)", () => {
  it("reports needsKey without throwing", () => {
    const info = describeProviderFromEnv({} as NodeJS.ProcessEnv);
    expect(info).toMatchObject({ kind: "openai-responses", needsKey: true });
  });

  it("local endpoint needs no key", () => {
    const info = describeProviderFromEnv({
      OPENAI_BASE_URL: "http://localhost:11434/v1",
    } as NodeJS.ProcessEnv);
    expect(info).toMatchObject({ kind: "openai-chat", needsKey: false });
  });
});

describe("API key handling", () => {
  it("flags /key lines as sensitive", () => {
    expect(isSensitiveLine("/key gsk_secret")).toBe(true);
    expect(isSensitiveLine("/KEY gsk_secret")).toBe(true);
    expect(isSensitiveLine("/model x")).toBe(false);
    expect(isSensitiveLine("fix the bug")).toBe(false);
  });

  it("throws a friendly error (not a stack) when the key is missing", () => {
    expect(() => createProviderFromEnv({} as NodeJS.ProcessEnv)).toThrow(/\/key/);
  });
});

describe("saveApiKeyToEnvFile", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "agent-key-"));
  });
  afterEach(async () => {
    delete process.env.OPENAI_API_KEY;
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("creates .env with the key", async () => {
    const file = saveApiKeyToEnvFile(tmp, "gsk_test123");
    expect(await fs.readFile(file, "utf8")).toContain("OPENAI_API_KEY=gsk_test123");
    expect(process.env.OPENAI_API_KEY).toBe("gsk_test123");
  });

  it("replaces an existing key line, preserving the rest", async () => {
    await fs.writeFile(path.join(tmp, ".env"), "MODEL=x\nOPENAI_API_KEY=old\nFOO=1\n");
    const file = saveApiKeyToEnvFile(tmp, "new");
    const content = await fs.readFile(file, "utf8");
    expect(content).toContain("OPENAI_API_KEY=new");
    expect(content).not.toContain("old");
    expect(content).toContain("MODEL=x");
    expect(content).toContain("FOO=1");
  });

  it("rejects keys with whitespace", () => {
    expect(() => saveApiKeyToEnvFile(tmp, "not a key")).toThrow();
  });
});

describe("session slash commands", () => {
  it("parses session slash commands", () => {
    expect(parseSlashCommand("/sessions")).toEqual({ cmd: "sessions", args: "" });
    expect(parseSlashCommand("/session resume 1")).toEqual({ cmd: "session", args: "resume 1" });
    expect(parseSlashCommand("/resume 2")).toEqual({ cmd: "resume", args: "2" });
    expect(parseSlashCommand("/new Auth feature")).toEqual({ cmd: "new", args: "Auth feature" });
  });

  it("parses thought slash commands", () => {
    expect(parseSlashCommand("/t")).toEqual({ cmd: "t", args: "" });
    expect(parseSlashCommand("/thought")).toEqual({ cmd: "thought", args: "" });
    expect(parseSlashCommand("/thought on")).toEqual({ cmd: "thought", args: "on" });
    expect(parseSlashCommand("/thought off")).toEqual({ cmd: "thought", args: "off" });
    expect(parseSlashCommand("/thought expand")).toEqual({ cmd: "thought", args: "expand" });
  });

  it("parses plan, todos, and worktree slash commands", () => {
    expect(parseSlashCommand("/plan")).toEqual({ cmd: "plan", args: "" });
    expect(parseSlashCommand("/plan on")).toEqual({ cmd: "plan", args: "on" });
    expect(parseSlashCommand("/plan off")).toEqual({ cmd: "plan", args: "off" });
    expect(parseSlashCommand("/todos")).toEqual({ cmd: "todos", args: "" });
    expect(parseSlashCommand("/tasks")).toEqual({ cmd: "tasks", args: "" });
    expect(parseSlashCommand("/worktree create feat-auth")).toEqual({
      cmd: "worktree",
      args: "create feat-auth",
    });
    expect(parseSlashCommand("/worktree main")).toEqual({ cmd: "worktree", args: "main" });
  });
});

describe("renderTodoList TUI component", () => {
  it("formats empty list gracefully", async () => {
    const { renderTodoList } = await import("../src/cli/ui/reporter.js");
    expect(renderTodoList([])).toBe("");
  });

  it("renders tasks matching Claude Code TaskListV2 standalone format", async () => {
    const { renderTodoList } = await import("../src/cli/ui/reporter.js");
    const output = renderTodoList(
      [
        { id: "1", content: "Inspect codebase", status: "completed" },
        { id: "2", content: "Implement feature", activeForm: "Implementing feature", status: "in_progress" },
        { id: "3", content: "Run tests", status: "pending" },
      ],
      { currentActivity: "Editing auth.ts" },
    );

    // Claude Code standalone format: 3 tasks (1 done, 1 in progress, 1 open)
    expect(output).toContain("tasks (");
    expect(output).toContain("done");
    expect(output).toContain("in progress");
    expect(output).toContain("open");
    expect(output).toContain("✔");
    expect(output).toContain("▪");
    expect(output).toContain("▫");
    expect(output).toContain("Inspect codebase");
    expect(output).toContain("Implement feature");
    expect(output).toContain("Run tests");
    expect(output).toContain("Editing auth.ts");
  });

  it("supports bordered format when requested", async () => {
    const { renderTodoList } = await import("../src/cli/ui/reporter.js");
    const output = renderTodoList(
      [
        { id: "1", content: "Inspect codebase", status: "completed" },
        { id: "2", content: "Implement feature", activeForm: "Implementing feature", status: "in_progress" },
      ],
      { bordered: true },
    );

    expect(output).toContain("Current Tasks");
    expect(output).toContain("╭─");
    expect(output).toContain("╰─");
  });
});

describe("handleSessionCommand", () => {
  let tmpHome: string;
  let tmpRepo: string;
  let session: SessionConfig;

  beforeEach(async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "codeagent-repl-home-"));
    tmpRepo = await fs.mkdtemp(path.join(os.tmpdir(), "codeagent-repl-repo-"));
    session = {
      repoRoot: tmpRepo,
      maxIterations: 5,
      sessionHome: tmpHome,
      history: [],
    };
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpHome, { recursive: true, force: true });
    await fs.rm(tmpRepo, { recursive: true, force: true });
  });

  it("lists sessions saved for the repository", () => {
    const saved = createSession(tmpRepo, { title: "Alpha", turnCount: 2 });
    saveSession(saved, tmpHome);
    handleSessionCommand(session, "list", "");
    expect(console.log).toHaveBeenCalled();
  });

  it("reports when no sessions exist", () => {
    handleSessionCommand(session, "list", "");
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("No saved sessions found"));
  });

  it("resumes a session by id, loading history and model settings", () => {
    const saved = createSession(tmpRepo, {
      title: "Fix auth",
      model: "test-model",
      history: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ],
    });
    saveSession(saved, tmpHome);

    handleSessionCommand(session, "resume", saved.id);
    expect(session.activeSession?.id).toBe(saved.id);
    expect(session.history).toHaveLength(2);
    expect(session.model).toBe("test-model");
  });

  it("resumes a session by list index (1-based)", () => {
    const saved = createSession(tmpRepo, { title: "Only session" });
    saveSession(saved, tmpHome);

    handleSessionCommand(session, "resume", "1");
    expect(session.activeSession?.id).toBe(saved.id);
  });

  it("warns when the requested session does not exist", () => {
    handleSessionCommand(session, "resume", "missing-id");
    expect(session.activeSession?.id).not.toBe("missing-id");
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("Session not found"));
  });

  it("starts a new session, saving the current one first", () => {
    const old = createSession(tmpRepo, { title: "Old", turnCount: 3 });
    session.activeSession = old;
    session.history = [{ role: "user", content: "old turn" }];

    handleSessionCommand(session, "new", "Fresh start");
    expect(session.activeSession?.title).toBe("Fresh start");
    expect(session.activeSession?.id).not.toBe(old.id);
    expect(session.history).toEqual([]);
    // The old session must have been persisted before switching.
    const oldOnDisk = loadSession(old.id, tmpHome);
    expect(oldOnDisk).not.toBeNull();
    expect(oldOnDisk?.history).toHaveLength(1);
  });

  it("saves (checkpoints) the active session with an optional new title", () => {
    session.activeSession = createSession(tmpRepo, { title: "Old title" });

    handleSessionCommand(session, "save", "Renamed");
    expect(session.activeSession?.title).toBe("Renamed");
    const onDisk = loadSession(session.activeSession!.id, tmpHome);
    expect(onDisk?.title).toBe("Renamed");
  });

  it("deletes a session by id and starts clean when it was active", () => {
    const saved = createSession(tmpRepo, { title: "Doomed" });
    saveSession(saved, tmpHome);
    session.activeSession = saved;
    session.history = [{ role: "user", content: "x" }];

    handleSessionCommand(session, "delete", saved.id);
    expect(loadSession(saved.id, tmpHome)).toBeNull();
    expect(session.activeSession?.id).not.toBe(saved.id);
    expect(session.history).toEqual([]);
  });

  it("rejects unknown session actions", () => {
    handleSessionCommand(session, "frobnicate", "");
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("Unknown session action"));
  });
});

