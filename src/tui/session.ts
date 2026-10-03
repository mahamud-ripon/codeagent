import fs from "node:fs";
import path from "node:path";
import {
  runTask,
  doRewind,
  parseSlashCommand,
  type SessionConfig,
} from "../cli/repl.js";
import type { AgentReporter } from "../cli/ui/reporter.js";
import {
  PermissionManager,
  cyclePermissionMode,
  type PermissionMode,
} from "../agent/permissions.js";
import { CheckpointManager } from "../agent/checkpoint.js";
import { TodoManager } from "../agent/todo.js";
import { PlanModeManager } from "../agent/planMode.js";
import { FileStateCache } from "../tools/fileStateCache.js";
import {
  loadHooksSettings,
  loadPermissionSettings,
} from "../agent/settings.js";
import { runHooks } from "../agent/hooks.js";
import { logAudit } from "../agent/audit.js";
import { describeProviderFromEnv } from "../llm/provider.js";
import { gitDiff, gitStatus } from "../tools/git.js";
import { getSandboxMode, removePersistentContainer } from "../tools/sandbox.js";
import {
  createSession,
  saveSession,
  listSessions,
  loadSession,
  exportSessionMarkdown,
  defaultExportFilename,
} from "../session/sessionManager.js";
import { TerminalScreen } from "./screen.js";

const HELP = [
  "Enter sends · Alt+Enter inserts a newline · Esc cancels · Ctrl+C cancels or exits",
  "Type while running to queue another prompt. /cancel clears the queue and interrupts.",
  "/help · /status · /model [name] · /mode default|acceptEdits|plan|bypass · /plan",
  "/diff · /undo · /sessions · /resume <session-id> · /new · /export [path]",
  "/cost · /clear · /exit",
  "Additional commands remain available through --ui=legacy.",
].join("\n");

/** Interactive presentation of the existing agent/session engine; one terminal owner. */
export async function startNextRepl(initial: SessionConfig): Promise<void> {
  const session: SessionConfig = { ...initial };
  const resumed = session.activeSession;
  if (resumed) {
    session.history = resumed.history;
    session.model ??= resumed.model;
    session.provider ??= resumed.provider;
    session.baseURL ??= resumed.baseURL;
    session.usage = resumed.usage;
  } else {
    session.activeSession = createSession(session.repoRoot, {
      model: session.model,
      provider: session.provider,
      baseURL: session.baseURL,
      history: session.history ?? [],
    });
  }
  session.checkpoints ??= new CheckpointManager(session.repoRoot);
  session.checkpoints.setCheckpoints(session.activeSession!.checkpoints ?? []);
  session.todoManager ??= new TodoManager();
  session.planModeManager ??= new PlanModeManager();
  session.fileStateCache ??= new FileStateCache();

  let ready = false;
  let running = false;
  let closing = false;
  let controller: AbortController | undefined;
  let current: Promise<void> = Promise.resolve();
  const queue: string[] = [];
  const containerIds = new Set<string>();
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const screen = new TerminalScreen({
    onSubmit: (text: string) => submit(text),
    onCancel: () => cancel(),
    onExit: () => exit(),
    onCycleMode: () => {
      if (!running && !closing)
        submit(`/mode ${cyclePermissionMode(session.permissions!.getMode())}`);
    },
  });
  const reportError = (error: unknown) =>
    screen.add("error", error instanceof Error ? error.message : String(error));
  const status = () => {
    let model = session.model ?? process.env.MODEL ?? "default";
    try {
      model = describeProviderFromEnv(process.env, {
        model: session.model,
        provider: session.provider,
        baseURL: session.baseURL,
      }).model;
    } catch {
      /* Missing credentials are explained when a task runs. */
    }
    screen.setStatus({
      model,
      mode: session.planModeManager!.isActive()
        ? "plan"
        : session.permissions!.getMode(),
      sandbox: getSandboxMode(),
      workspace: session.repoRoot,
      running,
      queued: queue.length,
      ...(!running
        ? {
            inputTokens: session.usage?.input ?? 0,
            outputTokens: session.usage?.output ?? 0,
            costUsd: session.usage?.costUsd ?? 0,
          }
        : {}),
    });
  };
  const persist = () => {
    const record = session.activeSession!;
    record.history = session.history ?? [];
    record.model = session.model;
    record.provider = session.provider;
    record.baseURL = session.baseURL;
    record.usage = session.usage;
    record.checkpoints = session.checkpoints!.listCheckpoints();
    saveSession(record, session.sessionHome);
  };
  const cancel = () => {
    queue.length = 0;
    controller?.abort();
    screen.cancelConfirmation();
    if (running)
      screen.add(
        "system",
        "Cancelling current operation; queued prompts cleared.",
      );
    status();
  };
  const exit = () => {
    if (closing) return;
    closing = true;
    cancel();
    resolveClosed();
  };
  let confirmationTail: Promise<boolean> = Promise.resolve(false);
  const confirm = (title: string, body: string): Promise<boolean> => {
    // Read tools can request permissions concurrently; each gets its own dialog.
    const signal = controller?.signal;
    confirmationTail = confirmationTail.then(async () => {
      if (closing || signal?.aborted) return false;
      const allowed = await screen.confirm(title, body);
      return allowed && !closing && !signal?.aborted;
    });
    return confirmationTail;
  };
  if (!session.permissions) {
    const settings = loadPermissionSettings(session.repoRoot);
    session.permissions = new PermissionManager({
      autoApprove: session.autoApprove ?? false,
      mode: session.autoApprove ? "bypass" : settings.mode,
      allow: settings.allow,
      deny: settings.deny,
      ask: settings.ask,
      handler: async (req) => {
        const allowed = await confirm(
          `Allow ${req.type}?`,
          [req.target, req.details, req.preview].filter(Boolean).join("\n\n"),
        );
        logAudit(session.repoRoot, {
          kind: "permission",
          tool: req.type,
          args: { target: req.target },
          decision: allowed ? "allow" : "deny",
        });
        return allowed;
      },
    });
  }
  if (session.permissions.getMode() === "plan") session.planModeManager.enter();
  session.planApprover ??= async (plan) => {
    const allowed = await confirm("Approve implementation plan?", plan);
    if (allowed && session.permissions!.getMode() === "plan")
      session.permissions!.setMode("default");
    status();
    return allowed;
  };

  // Text/tool events have one rendering path. Callbacks cover only events the core
  // does not yet emit (progress, todos and plan changes).
  const reporter: AgentReporter = {
    onIterationStart: () => {},
    onToolStart: () => {},
    onToolComplete: () => {},
    stop: () => {},
    onProgressMessage: (message) => screen.add("system", message),
    onError: (message) => screen.add("error", message),
    onTodoUpdate: (todos) => screen.handleEvent({ type: "todo_update", todos }),
    onPlanModeChange: () => status(),
  };

  function showHistory(): void {
    for (const item of (session.history ?? []).slice(-100)) {
      if (!item || typeof item !== "object") continue;
      const message = item as {
        role?: string;
        type?: string;
        content?: unknown;
        text?: string;
      };
      const role =
        message.role ?? (message.type === "message" ? "assistant" : undefined);
      if (role !== "user" && role !== "assistant") continue;
      const text =
        typeof message.content === "string"
          ? message.content
          : Array.isArray(message.content)
            ? message.content
                .map((block: { text?: string }) =>
                  typeof block?.text === "string" ? block.text : "",
                )
                .filter(Boolean)
                .join("\n")
            : message.text;
      if (text) screen.add(role, text);
    }
  }

  async function command(text: string): Promise<void> {
    const { cmd, args } = parseSlashCommand(text)!;
    switch (cmd) {
      case "help":
        screen.add("system", HELP);
        break;
      case "clear":
        screen.clear();
        break;
      case "status":
        screen.add(
          "system",
          `Session: ${session.activeSession!.id}\nWorkspace: ${session.repoRoot}\nMode: ${session.permissions!.getMode()}\n${await gitStatus(session.repoRoot)}`,
        );
        break;
      case "cost":
        screen.add(
          "system",
          `${session.usage?.input ?? 0} input / ${session.usage?.output ?? 0} output tokens · $${(session.usage?.costUsd ?? 0).toFixed(4)}`,
        );
        break;
      case "model":
        if (args) {
          session.model = args;
          persist();
        }
        screen.add(
          "system",
          `Model: ${session.model ?? process.env.MODEL ?? "provider default"}`,
        );
        break;
      case "mode": {
        const modes: PermissionMode[] = [
          "default",
          "acceptEdits",
          "plan",
          "bypass",
        ];
        if (!args) {
          screen.add("system", `Mode: ${session.permissions!.getMode()}`);
          break;
        }
        if (!modes.includes(args as PermissionMode))
          throw new Error("Usage: /mode default|acceptEdits|plan|bypass");
        if (
          args === "bypass" &&
          !(await confirm(
            "Enable bypass permissions?",
            "The agent will run operations without asking and skip permission deny rules. Only enable this for a trusted workspace.",
          ))
        )
          break;
        session.permissions!.setMode(args as PermissionMode);
        session.autoApprove = args === "bypass";
        if (args === "plan") session.planModeManager!.enter();
        else session.planModeManager!.exit();
        screen.add("system", `Permission mode: ${args}`);
        break;
      }
      case "plan":
        session.permissions!.setMode("plan");
        session.autoApprove = false;
        screen.add("system", session.planModeManager!.enter());
        break;
      case "diff":
        screen.add(
          "system",
          (await gitDiff(session.repoRoot)) || "No tracked changes.",
        );
        break;
      case "undo": {
        if (!session.activeSession!.turns?.length) {
          screen.add("system", "No turns to undo.");
          break;
        }
        if (
          !(await confirm(
            "Restore files to before the last turn?",
            "This restores a checkpoint and can discard subsequent changes in the workspace. Conversation history is retained.",
          ))
        )
          break;
        const result = await doRewind(session, "last", "code");
        session.fileStateCache = new FileStateCache();
        screen.add(result.ok ? "system" : "error", result.message);
        break;
      }
      case "sessions": {
        const records = listSessions(session.repoRoot, session.sessionHome);
        screen.add(
          "system",
          records.length
            ? records
                .map((r) => `${r.id} · ${r.title} · ${r.turnCount} turns`)
                .join("\n")
            : "No saved sessions. Send a prompt to begin.",
        );
        break;
      }
      case "resume": {
        if (!/^ses_[A-Za-z0-9_-]+$/.test(args))
          throw new Error("Usage: /resume <session-id> (see /sessions)");
        const record = loadSession(args, session.sessionHome);
        if (
          !record ||
          path.resolve(record.repoRoot) !== path.resolve(session.repoRoot)
        )
          throw new Error("Session not found in this workspace.");
        persist();
        session.activeSession = record;
        session.history = record.history;
        session.model = record.model;
        session.provider = record.provider;
        session.baseURL = record.baseURL;
        session.usage = record.usage;
        session.checkpoints!.setCheckpoints(record.checkpoints ?? []);
        session.todoManager = new TodoManager();
        session.fileStateCache = new FileStateCache();
        screen.clear();
        screen.handleEvent({ type: "todo_update", todos: [] });
        showHistory();
        screen.add(
          "system",
          `Resumed ${record.id}: ${record.title} (${record.turnCount} turns in context).`,
        );
        break;
      }
      case "new":
        persist();
        session.history = [];
        session.usage = undefined;
        session.activeSession = createSession(session.repoRoot, {
          model: session.model,
          provider: session.provider,
          baseURL: session.baseURL,
        });
        session.checkpoints!.setCheckpoints([]);
        session.todoManager = new TodoManager();
        session.fileStateCache = new FileStateCache();
        screen.clear();
        screen.handleEvent({ type: "todo_update", todos: [] });
        screen.add("system", `New session: ${session.activeSession.id}`);
        break;
      case "export": {
        persist();
        const target = path.resolve(
          session.repoRoot,
          args || defaultExportFilename(session.activeSession!),
        );
        fs.writeFileSync(
          target,
          exportSessionMarkdown(session.activeSession!),
          { encoding: "utf8", flag: "wx", mode: 0o600 },
        );
        screen.add("system", `Exported session to ${target}`);
        break;
      }
      default:
        throw new Error(
          `Unknown TUI command /${cmd}. Use /help, or --ui=legacy for additional commands.`,
        );
    }
  }

  async function task(text: string): Promise<void> {
    screen.add("user", text);
    const historyStart = session.history?.length ?? 0;
    const checkpoint = await session.checkpoints!.saveCheckpoint(text);
    if (checkpoint) {
      session.activeSession!.checkpoints =
        session.checkpoints!.listCheckpoints();
      saveSession(session.activeSession!, session.sessionHome);
    }
    if (controller!.signal.aborted || closing) return;
    containerIds.add(session.activeSession!.id);
    await runTask(
      session,
      text,
      controller!.signal,
      {
        historyStart,
        checkpointId: checkpoint?.id,
        checkpointHash: checkpoint?.commitHash,
      },
      {
        reporter,
        onEvent: (event) => screen.handleEvent(event),
        log: (message) => screen.add("system", message),
        onResult: (result, durationMs) =>
          screen.finish(result.finalMessage, durationMs),
        askUser: (question) => {
          if (closing || controller?.signal.aborted)
            return Promise.resolve("User cancelled the question.");
          return screen.ask(question);
        },
      },
    );
  }

  function submit(raw: string): void {
    const text = raw.trim();
    if (!text || closing) return;
    const parsed = parseSlashCommand(text);
    if (parsed?.cmd === "exit" || parsed?.cmd === "quit") {
      exit();
      return;
    }
    if (parsed?.cmd === "cancel") {
      cancel();
      return;
    }
    if (!ready) {
      screen.add(
        "system",
        "Session startup is still running. Please submit again when ready.",
      );
      return;
    }
    if (running) {
      if (parsed) {
        screen.add(
          "system",
          "Wait for the current operation before using commands. /cancel and /exit remain available.",
        );
        return;
      }
      if (queue.length >= 20) {
        screen.add(
          "error",
          "Queue is full (20 prompts). Wait or use /cancel to clear it.",
        );
        return;
      }
      queue.push(text);
      status();
      return;
    }
    running = true;
    controller = new AbortController();
    status();
    current = (async () => {
      try {
        if (parsed) await command(text);
        else await task(text);
      } catch (error) {
        reportError(error);
      } finally {
        running = false;
        controller = undefined;
        status();
        if (!closing) {
          const next = queue.shift();
          if (next) submit(next);
        }
      }
    })();
  }

  const onInterrupt = () => {
    if (running) cancel();
    else exit();
  };
  const onSignal = () => exit();
  const onInputEnd = () => exit();
  try {
    screen.start();
    process.on("SIGINT", onInterrupt);
    process.on("SIGTERM", onSignal);
    process.on("SIGHUP", onSignal);
    process.stdin.on("end", onInputEnd);
    status();
    screen.add(
      "system",
      `Codeagent terminal · ${session.activeSession!.id}\n${HELP}`,
    );
    try {
      const hooks = loadHooksSettings(session.repoRoot);
      if (hooks.SessionStart)
        await runHooks(hooks, "SessionStart", {
          repoRoot: session.repoRoot,
          sessionId: session.activeSession!.id,
        });
    } catch (error) {
      reportError(error);
    }
    if (resumed) showHistory();
    ready = true;
    await closed;
    await current;
    persist();
  } finally {
    closing = true;
    controller?.abort();
    screen.stop();
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onSignal);
    process.removeListener("SIGHUP", onSignal);
    process.stdin.removeListener("end", onInputEnd);
    await Promise.allSettled(
      [...containerIds].map((id) => removePersistentContainer(id)),
    );
  }
}
