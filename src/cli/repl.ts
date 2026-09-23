import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { Agent } from "../agent/agent.js";
import {
  createProviderFromEnv,
  describeProviderFromEnv,
  MissingApiKeyError,
  type ProviderOverrides,
} from "../llm/provider.js";
import { gitDiff, gitStatus } from "../tools/git.js";
import { deleteEnvKey, ensureEndpointForKey, globalEnvPath, upsertEnvKey } from "./config.js";

// Re-exported for existing callers/tests; canonical home is ./config.js.
export { detectEndpointForKey } from "./config.js";

/**
 * Interactive REPL (Claude-Code style): `codeagent` with no task drops
 * here instead of exiting. Thin layer over the same Agent core as
 * one-shot mode — zero agent logic lives in this file.
 */

import { PermissionManager } from "../agent/permissions.js";
import { compactHistory } from "../agent/compactor.js";
import { CheckpointManager } from "../agent/checkpoint.js";
import { getSandboxMode, setSandboxMode } from "../tools/sandbox.js";
import {
  createSession,
  deleteSession,
  formatTimeAgo,
  listSessions,
  loadSession,
  saveSession,
  type SessionRecord,
} from "../session/sessionManager.js";
import {
  renderBanner,
  ConsoleAgentReporter,
  formatMarkdown,
  formatDiff,
  promptPermission,
  promptSessionSelect,
  printUserMessage,
  formatThoughtLine,
  latestThought,
  pc,
  icons,
  colors,
} from "./ui/index.js";

export interface SessionConfig {
  repoRoot: string;
  model?: string;
  provider?: string;
  baseURL?: string;
  maxIterations: number;
  history?: unknown[];
  permissions?: PermissionManager;
  checkpoints?: CheckpointManager;
  activeSession?: SessionRecord;
  autoExpandThought?: boolean;
}


export interface SlashCommand {
  cmd: string;
  args: string;
}

/** Parse "/cmd args..." — returns null for non-slash input. */
export function parseSlashCommand(line: string): SlashCommand | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("/")) return null;
  const space = trimmed.indexOf(" ");
  if (space === -1) return { cmd: trimmed.slice(1).toLowerCase(), args: "" };
  return {
    cmd: trimmed.slice(1, space).toLowerCase(),
    args: trimmed.slice(space + 1).trim(),
  };
}

// Minimal ANSI styling aliases for backward compatibility.
const c = {
  bold: (s: string) => pc.bold(s),
  dim: (s: string) => pc.dim(s),
  cyan: (s: string) => pc.cyan(s),
  green: (s: string) => pc.green(s),
  red: (s: string) => pc.red(s),
  yellow: (s: string) => pc.yellow(s),
};

function readVersion(): string {
  try {
    // src/cli/repl.ts and dist/cli/repl.js both sit two levels below root.
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkgPath = path.resolve(here, "..", "..", "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { version?: string };
    return pkg.version ?? "0.1.0";
  } catch {
    return "0.1.0";
  }
}

function historyPath(): string {
  const dir = path.join(os.homedir(), ".codeagent");
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // History is best-effort; a read-only home must not break the REPL.
  }
  return path.join(dir, "history");
}

function loadHistory(rl: readline.Interface): void {
  try {
    const file = historyPath();
    if (!fs.existsSync(file)) return;
    const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).slice(-200);
    for (const line of lines) (rl as unknown as { history: string[] }).history.push(line);
  } catch {
    // ignore
  }
}

function saveHistory(line: string): void {
  if (isSensitiveLine(line)) return; // never persist secrets
  try {
    fs.appendFileSync(historyPath(), line + "\n");
  } catch {
    // ignore
  }
}

function sessionOverrides(session: SessionConfig): ProviderOverrides {
  return {
    model: session.model ?? process.env.MODEL,
    provider: session.provider ?? process.env.LLM_PROVIDER,
    baseURL: session.baseURL ?? process.env.OPENAI_BASE_URL,
  };
}

/** Lines that must never touch the history file (secrets). */
export function isSensitiveLine(line: string): boolean {
  return parseSlashCommand(line)?.cmd === "key";
}

/**
 * Persist an API key and activate it for this process.
 * Global scope (~/.codeagent/.env) = configure once; the key follows
 * you to every directory. Local scope (<repo>/.env) = per-project
 * override that wins over the global one.
 */
export function saveApiKeyToEnvFile(dir: string, key: string): string {
  const file = upsertEnvKey(path.join(path.resolve(dir), ".env"), "OPENAI_API_KEY", key);
  process.env.OPENAI_API_KEY = key;
  return file;
}

export function saveGlobalApiKey(key: string): string {
  const file = upsertEnvKey(globalEnvPath(), "OPENAI_API_KEY", key);
  process.env.OPENAI_API_KEY = key;
  return file;
}

/** Persist a session default globally (best-effort; session still works if it fails). */
function persistGlobal(name: string, value: string | undefined): void {
  try {
    if (value === undefined) deleteEnvKey(globalEnvPath(), name);
    else upsertEnvKey(globalEnvPath(), name, value);
  } catch {
    // ignore — in-memory session value still applies
  }
}

function printBanner(session: SessionConfig): void {
  const info = describeProviderFromEnv(process.env, sessionOverrides(session));
  renderBanner({
    repoRoot: session.repoRoot,
    model: info.model,
    providerKind: info.kind,
    baseURL: info.baseURL,
    sessionId: session.activeSession?.id,
    sessionTitle: session.activeSession?.title,
    turnCount: session.activeSession?.turnCount ?? (session.history ? Math.floor(session.history.length / 2) : 0),
    needsKey: info.needsKey,
  });
}

function printHelp(): void {
  console.log(`
  ${pc.bold(pc.cyan("Session & Workspace Commands:"))}
    ${pc.cyan("/sessions")}               List and interactively select saved sessions
    ${pc.cyan("/session resume <n|id>")}  Resume a past session by index or ID (alias: /resume <n>)
    ${pc.cyan("/session new [title]")}    Start a fresh session (alias: /new)
    ${pc.cyan("/session save [title]")}   Rename or checkpoint the current session
    ${pc.cyan("/session delete <n|id>")}  Delete a saved session from disk
    ${pc.cyan("/undo, /revert")}          Revert workspace files to state before last task run
    ${pc.cyan("/checkpoints")}            List recorded turn checkpoints
    ${pc.cyan("/repo <path>")}            Switch workspace repository root

  ${pc.bold(pc.cyan("Model & API Configuration:"))}
    ${pc.cyan("/model <id>")}             Switch model (e.g. /model openai/gpt-oss-20b)
    ${pc.cyan("/provider <name>")}        Switch backend provider: openai | chat
    ${pc.cyan("/endpoint <url>")}         Set OpenAI-compatible base URL (implies chat); "off" clears
    ${pc.cyan("/key <api-key>")}          Save key globally (~/.codeagent/.env) — configure once
    ${pc.cyan("/key --local <k>")}        Save key to <repo>/.env (per-project override)
    ${pc.cyan("/sandbox [docker|local]")} Switch execution environment between Docker and local host
    ${pc.cyan("/iterations <n>")}         Set max iterations for subsequent runs

  ${pc.bold(pc.cyan("Context & Code Inspection:"))}
    ${pc.cyan("/thought [on|off]")}       Toggle thinking display (or press Ctrl+T, alias: /t)
    ${pc.cyan("/diff")}                   Show colorized git diff
    ${pc.cyan("/compact")}                Compact conversation memory to reduce token usage
    ${pc.cyan("/status")}                 Show repo / provider / model / session settings
    ${pc.cyan("/clear")}                  Clear the screen and reset session conversation memory
    ${pc.cyan("/help")}                   Show this help menu
    ${pc.cyan("/exit, /quit")}            Leave codeagent
`);
}

function printStatus(session: SessionConfig): void {
  const info = describeProviderFromEnv(process.env, sessionOverrides(session));
  const turnCount = session.history && session.history.length > 0 ? Math.floor(session.history.length / 2) : 0;
  console.log(`
  ${pc.bold(pc.cyan("Session Status"))}
  ${pc.dim("─".repeat(45))}
  ${pc.bold("ID:")}            ${session.activeSession?.id ? pc.cyan(session.activeSession.id) : pc.dim("none")}
  ${pc.bold("Title:")}         ${session.activeSession?.title ? pc.white(session.activeSession.title) : pc.dim("none")}
  ${pc.bold("Workspace:")}     ${session.repoRoot}
  ${pc.bold("Provider:")}      ${pc.magenta(info.kind)}${info.baseURL ? pc.dim(` (${info.baseURL})`) : ""}
  ${pc.bold("Model:")}         ${pc.yellow(info.model)}
  ${pc.bold("Max Iter:")}      ${pc.white(String(session.maxIterations))}
  ${pc.bold("API Key:")}       ${info.needsKey ? pc.yellow("missing — run /key <api-key>") : pc.green("configured")}
  ${pc.bold("Context Memory:")} ${turnCount > 0 ? pc.green(`${turnCount} turn(s) in context`) : pc.dim("empty")}
`);
}

async function runTask(session: SessionConfig, task: string, signal: AbortSignal): Promise<void> {
  // Heal keys saved before auto-detect existed (or pasted into .env by hand).
  for (const notice of ensureEndpointForKey({
    provider: session.provider,
    baseURL: session.baseURL,
    model: session.model,
  })) {
    console.log(pc.yellow(notice));
  }
  let provider;
  try {
    provider = createProviderFromEnv(process.env, sessionOverrides(session));
  } catch (error) {
    if (error instanceof MissingApiKeyError) {
      console.error(pc.yellow(`\n${error.message}\n`));
      return;
    }
    throw error;
  }
  const { responder, info } = provider;
  const reporter = new ConsoleAgentReporter(session.repoRoot, session.autoExpandThought);
  const agent = new Agent({
    repoRoot: session.repoRoot,
    model: info.model,
    maxIterations: session.maxIterations,
    responder,
    permissions: session.permissions,
    reporter,
  });
  try {
    const result = await agent.run(task, { signal, history: session.history });
    if (result.history) {
      session.history = compactHistory(result.history);
    }
    // Auto-save the active session on disk
    if (session.activeSession) {
      session.activeSession.turnCount++;
      session.activeSession.history = session.history ?? [];
      if (session.activeSession.title === "New session" || !session.activeSession.title) {
        session.activeSession.title = task.slice(0, 60);
      }
      for (const f of result.modifiedFiles) {
        if (!session.activeSession.modifiedFiles.includes(f)) {
          session.activeSession.modifiedFiles.push(f);
        }
      }
      session.activeSession.model = info.model;
      session.activeSession.provider = session.provider;
      session.activeSession.baseURL = session.baseURL;
      saveSession(session.activeSession);
    }

    // Rich formatted assistant response
    console.log("");
    console.log(formatMarkdown(result.finalMessage));
    console.log("");

    const stats: string[] = [
      `${pc.bold("iterations:")} ${pc.cyan(String(result.iterations))}`,
      `${pc.bold("files:")} ${result.modifiedFiles.length > 0 ? pc.green(result.modifiedFiles.join(", ")) : pc.dim("(none)")}`,
    ];
    if (result.testResults && result.testResults.length > 0) {
      const passed = result.testResults.filter((t) => t.exitCode === 0).length;
      stats.push(`${pc.bold("tests:")} ${passed === result.testResults.length ? pc.green(`all ${passed} passed`) : pc.yellow(`${passed}/${result.testResults.length} passed`)}`);
    }
    console.log(pc.dim("─".repeat(50)));
    console.log(`  ${stats.join(" · ")}`);
    console.log("");
  } catch (error) {
    reporter.stop();
    if (signal.aborted) {
      console.log(pc.yellow("\nRun cancelled."));
      return;
    }
    console.error(pc.red(`\nAgent failed: ${error instanceof Error ? error.message : error}`));
  }
}


export function handleSessionCommand(session: SessionConfig, subcmd: string, restArgs: string): void {
  const op = subcmd.toLowerCase();
  if (!op || op === "list") {
    const list = listSessions(restArgs.includes("--all") ? undefined : session.repoRoot);
    if (list.length === 0) {
      console.log(c.dim("  No saved sessions found for this repository."));
      return;
    }
    console.log(`\n  ${c.bold("Saved sessions:")}`);
    list.forEach((s, idx) => {
      const isActive = s.id === session.activeSession?.id;
      const marker = isActive ? c.green(" [Active]") : "";
      const age = c.dim(`(${formatTimeAgo(s.updatedAt)}, ${s.turnCount} turns)`);
      console.log(`    ${c.bold(`${idx + 1}.`)} ${c.cyan(s.id)}${marker} ${age} - ${s.title}`);
    });
    console.log(c.dim("\n  Use /session resume <number | id> to resume a session.\n"));
    return;
  }

  if (op === "resume") {
    const target = restArgs.trim();
    if (!target) {
      console.log(c.dim("Usage: /session resume <number | session-id>"));
      return;
    }
    const list = listSessions(session.repoRoot);
    const num = Number(target);
    let targetId = target;
    if (!isNaN(num) && num >= 1 && num <= list.length) {
      targetId = list[num - 1].id;
    }
    const loaded = loadSession(targetId);
    if (!loaded) {
      console.log(c.yellow(`Session not found: ${target}`));
      return;
    }
    // Save current session first if it has turns or history
    if (session.activeSession && (session.activeSession.turnCount > 0 || (session.history && session.history.length > 0))) {
      session.activeSession.history = session.history ?? [];
      saveSession(session.activeSession);
    }
    session.activeSession = loaded;
    session.history = loaded.history ?? [];
    if (loaded.model) session.model = loaded.model;
    if (loaded.provider) session.provider = loaded.provider;
    if (loaded.baseURL) session.baseURL = loaded.baseURL;
    console.log(`Resumed session ${c.cyan(loaded.id)}: "${c.bold(loaded.title)}" (${c.green(`${Math.floor(session.history.length / 2)} turn(s)`)} in context).`);
    return;
  }

  if (op === "new") {
    if (session.activeSession && (session.activeSession.turnCount > 0 || (session.history && session.history.length > 0))) {
      session.activeSession.history = session.history ?? [];
      saveSession(session.activeSession);
    }
    session.activeSession = createSession(session.repoRoot, {
      title: restArgs || "New session",
      model: session.model,
      provider: session.provider,
      baseURL: session.baseURL,
    });
    session.history = [];
    saveSession(session.activeSession);
    console.log(`Started new session ${c.cyan(session.activeSession.id)}: "${c.bold(session.activeSession.title)}".`);
    return;
  }

  if (op === "save") {
    if (!session.activeSession) {
      session.activeSession = createSession(session.repoRoot, { history: session.history ?? [] });
    }
    if (restArgs) {
      session.activeSession.title = restArgs;
    }
    session.activeSession.history = session.history ?? [];
    saveSession(session.activeSession);
    console.log(`Saved session ${c.cyan(session.activeSession.id)}: "${c.bold(session.activeSession.title)}".`);
    return;
  }

  if (op === "delete" || op === "del" || op === "rm") {
    const target = restArgs.trim();
    if (!target) {
      console.log(c.dim("Usage: /session delete <number | session-id>"));
      return;
    }
    const list = listSessions(session.repoRoot);
    const num = Number(target);
    let targetId = target;
    if (!isNaN(num) && num >= 1 && num <= list.length) {
      targetId = list[num - 1].id;
    }
    const success = deleteSession(targetId);
    if (success) {
      console.log(`Deleted session ${c.cyan(targetId)}.`);
      if (session.activeSession?.id === targetId) {
        session.activeSession = createSession(session.repoRoot);
        session.history = [];
        console.log(c.dim("Active session was deleted. Started new clean session."));
      }
    } else {
      console.log(c.yellow(`Could not delete session: ${target}`));
    }
    return;
  }

  console.log(c.yellow(`Unknown session action '${subcmd}'. Try: /sessions, /session resume <n>, /session new, /session delete <n>`));
}

export async function startRepl(initial: SessionConfig): Promise<void> {
  const session: SessionConfig = { ...initial };
  if (!session.activeSession) {
    session.activeSession = createSession(session.repoRoot, {
      model: session.model,
      provider: session.provider,
      baseURL: session.baseURL,
      history: session.history ?? [],
    });
    if (session.history && session.history.length > 0) {
      session.activeSession.turnCount = Math.floor(session.history.length / 2);
    }
  } else {
    // If a session was passed in (e.g. via --resume)
    session.history = session.activeSession.history ?? [];
    if (session.activeSession.model && !session.model) session.model = session.activeSession.model;
    if (session.activeSession.provider && !session.provider) session.provider = session.activeSession.provider;
    if (session.activeSession.baseURL && !session.baseURL) session.baseURL = session.activeSession.baseURL;
  }
  if (!session.checkpoints) {
    session.checkpoints = new CheckpointManager(session.repoRoot);
  }
  // Heal keys saved before auto-detect existed (or pasted into .env by hand).
  const startupNotices = ensureEndpointForKey({
    provider: session.provider,
    baseURL: session.baseURL,
    model: session.model,
  });
  printBanner(session);
  for (const notice of startupNotices) console.log(`  ${c.yellow(notice)}`);
  if (startupNotices.length > 0) console.log("");

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${pc.bold(pc.cyan("▲"))} ${pc.bold(">")} `,
  });
  loadHistory(rl);

  if (!session.permissions) {
    session.permissions = new PermissionManager({
      autoApprove: false,
      handler: async (req) => {
        rl.pause();
        try {
          const decision = await promptPermission(req.target);
          if (decision === "always") {
            const prefix = req.target.split(/\s+/)[0];
            session.permissions?.allowPrefix(prefix);
            console.log(pc.dim(`  ${icons.check} Allowed '${prefix}' commands for this session.`));
            return true;
          }
          return decision === "yes";
        } finally {
          rl.resume();
        }
      },
    });
  }

  let running = false;
  let controller = new AbortController();
  let sigintCount = 0;
  let thoughtExpanded = session.autoExpandThought ?? false;

  const onKeypress = (_str: string, key: readline.Key) => {
    if (running) return;
    if (key && key.ctrl && (key.name === "t" || key.name === "o")) {
      if (latestThought?.text) {
        thoughtExpanded = !thoughtExpanded;
        readline.cursorTo(process.stdout, 0);
        readline.clearLine(process.stdout, 0);
        console.log(`\n${formatThoughtLine(latestThought.durationMs, thoughtExpanded, latestThought.text)}\n`);
        rl.prompt(true);
      }
    }
  };

  if (process.stdin.isTTY) {
    process.stdin.on("keypress", onKeypress);
  }

  // Manual SIGINT handling: cancel run first, exit only when idle.
  rl.on("SIGINT", () => {
    if (running) {
      console.log(c.yellow("\nCancelling... (finishing current tool call)"));
      controller.abort();
      return;
    }
    sigintCount++;
    if (sigintCount >= 2) {
      if (process.stdin.isTTY) {
        process.stdin.removeListener("keypress", onKeypress);
      }
      console.log(c.dim("\nBye."));
      rl.close();
    } else {
      console.log(c.dim("\n(To exit, press Ctrl+C again or type /exit)"));
      rl.prompt();
    }
  });

  rl.prompt();

  for await (const line of rl) {
    sigintCount = 0;
    const trimmed = line.trim();

    if (!trimmed) {
      rl.prompt();
      continue;
    }
    saveHistory(trimmed);

    const slash = parseSlashCommand(trimmed);
    if (slash) {
      const { cmd, args } = slash;
      switch (cmd) {
        case "help":
          printHelp();
          break;
        case "status":
          printStatus(session);
          break;
        case "key": {
          const tokens = args.split(/\s+/).filter(Boolean);
          const local = tokens.includes("--local");
          const key = tokens.filter((t) => t !== "--local").join("");
          if (!key) {
            console.log(c.dim("Usage: /key <api-key> [--local]  (never stored in history)"));
          } else {
            try {
              const file = local
                ? saveApiKeyToEnvFile(session.repoRoot, key)
                : saveGlobalApiKey(key);
              console.log(
                `API key saved ${local ? "to this project" : "globally"} (${c.cyan(file)}) and active for this session.`,
              );
              const notices = ensureEndpointForKey(
                {
                  provider: session.provider,
                  baseURL: session.baseURL,
                  model: session.model,
                  persistGlobals: !local,
                },
              );
              // Sync session view with healed env fallbacks.
              const healed = describeProviderFromEnv(process.env, sessionOverrides(session));
              if (healed.baseURL && !session.baseURL) session.baseURL = healed.baseURL;
              if (!session.model && process.env.MODEL) session.model = process.env.MODEL;
              for (const notice of notices) console.log(c.cyan(notice));
            } catch (error) {
              console.error(c.red(`Could not save key: ${error instanceof Error ? error.message : error}`));
            }
          }
          break;
        }
        case "model":
          if (!args) {
            console.log(c.dim("Usage: /model <id>"));
          } else {
            session.model = args;
            persistGlobal("MODEL", args);
            console.log(`Model → ${c.cyan(args)} (persisted globally)`);
          }
          break;
        case "provider":
          if (args !== "openai" && args !== "chat") {
            console.log(c.dim("Usage: /provider openai|chat"));
          } else {
            session.provider = args;
            persistGlobal("LLM_PROVIDER", args);
            console.log(`Provider → ${c.cyan(args)} (persisted globally)`);
          }
          break;
        case "endpoint":
          if (!args) {
            console.log(c.dim("Usage: /endpoint <url> | off"));
          } else if (args.toLowerCase() === "off") {
            session.baseURL = undefined;
            persistGlobal("OPENAI_BASE_URL", undefined);
            console.log("Endpoint override cleared.");
          } else {
            session.baseURL = args;
            persistGlobal("OPENAI_BASE_URL", args);
            console.log(`Endpoint → ${c.cyan(args)} (implies chat backend, persisted globally)`);
          }
          break;
        case "repo":
          if (!args) {
            console.log(c.dim("Usage: /repo <path>"));
          } else {
            session.repoRoot = path.resolve(args);
            console.log(`Repository → ${c.cyan(session.repoRoot)}`);
          }
          break;
        case "iterations":
          if (!/^\d+$/.test(args) || Number(args) < 1) {
            console.log(c.dim("Usage: /iterations <positive number>"));
          } else {
            session.maxIterations = Number(args);
            console.log(`Max iterations → ${c.cyan(args)}`);
          }
          break;
        case "diff":
          try {
            const raw = await gitDiff(session.repoRoot);
            console.log("");
            console.log(formatDiff(raw));
            console.log("");
          } catch (error) {
            console.error(pc.red(`git diff failed: ${error instanceof Error ? error.message : error}`));
          }
          break;
        case "sandbox": {
          const mode = args.toLowerCase().trim();
          if (mode === "docker" || mode === "local") {
            const res = await setSandboxMode(mode as "docker" | "local");
            if (res.success) {
              console.log(pc.green(`  ✔ ${res.message}`));
            } else {
              console.log(pc.yellow(`  ⚠️ ${res.message}`));
            }
          } else {
            const current = getSandboxMode();
            console.log(`  Current sandbox mode: ${c.cyan(current)} (options: /sandbox docker | /sandbox local)`);
          }
          break;
        }
        case "t":
        case "thought":
        case "thinking": {
          const mode = args.toLowerCase().trim();
          if (mode === "on" || mode === "always" || mode === "expand") {
            session.autoExpandThought = true;
            console.log(pc.green(`  ✔ Always expand thought is now ON.`));
          } else if (mode === "off" || mode === "collapse") {
            session.autoExpandThought = false;
            console.log(pc.green(`  ✔ Always expand thought is now OFF.`));
          } else {
            if (latestThought?.text) {
              thoughtExpanded = !thoughtExpanded;
              console.log(`\n${formatThoughtLine(latestThought.durationMs, thoughtExpanded, latestThought.text)}\n`);
            } else {
              console.log(c.dim("  No thinking text recorded for the latest turn."));
            }
          }
          break;
        }
        case "compact":
          if (session.history && session.history.length > 0) {
            const before = session.history.length;
            session.history = compactHistory(session.history, { keepRecentToolOutputs: 1, aggressive: true });
            console.log(`Compacted context memory (${c.cyan(`${before} items`)} → ${c.green(`${session.history.length} items`)}).`);
          } else {
            console.log(c.dim("Context memory is already compact / empty."));
          }
          break;
        case "sessions":
          handleSessionCommand(session, "list", args);
          break;
        case "session": {
          const parts = args.trim().split(/\s+/);
          const subcmd = parts[0] || "list";
          const rest = parts.slice(1).join(" ");
          handleSessionCommand(session, subcmd, rest);
          break;
        }
        case "resume":
          handleSessionCommand(session, "resume", args);
          break;
        case "new":
          handleSessionCommand(session, "new", args);
          break;
        case "undo":
        case "revert": {
          if (!session.checkpoints) {
            console.log(c.yellow("  No checkpoint manager available for this session."));
            break;
          }
          const restored = await session.checkpoints.restoreLastCheckpoint();
          if (restored) {
            console.log(pc.green(`  ✔ Reverted workspace to checkpoint: "${restored.label}" (${restored.id})`));
            const status = await gitStatus(session.repoRoot);
            if (status && status !== "(clean)") {
              console.log(c.dim("  git status:\n") + status.split("\n").map((l) => "    " + l).join("\n"));
            } else {
              console.log(c.dim("  Working tree is clean."));
            }
          } else {
            console.log(c.yellow("  No checkpoints available to undo."));
          }
          break;
        }
        case "checkpoints": {
          const list = session.checkpoints?.listCheckpoints() ?? [];
          if (list.length === 0) {
            console.log(c.dim("  No checkpoints saved yet in this session."));
          } else {
            console.log(pc.bold("\nSession Checkpoints:"));
            list.forEach((cp, idx) => {
              console.log(`  ${idx + 1}. ${c.cyan(cp.id)}: "${cp.label}" (${new Date(cp.timestamp).toLocaleTimeString()})`);
            });
            console.log(c.dim("\n  Type /undo to revert to the most recent checkpoint.\n"));
          }
          break;
        }
        case "clear":
          console.clear();
          session.history = [];
          if (session.activeSession) {
            session.activeSession = createSession(session.repoRoot, {
              model: session.model,
              provider: session.provider,
              baseURL: session.baseURL,
            });
            saveSession(session.activeSession);
          }
          printBanner(session);
          break;
        case "exit":
        case "quit":
          console.log(c.dim("Bye."));
          rl.close();
          return;
        default:
          console.log(c.yellow(`Unknown command /${cmd}. Try /help.`));
          break;
      }
      rl.prompt();
      continue;
    }

    // Plain text = a task. Take a checkpoint before execution so the user can /undo if needed.
    if (session.checkpoints) {
      await session.checkpoints.saveCheckpoint(trimmed);
    }

    running = true;
    controller = new AbortController();
    // Show a styled user message block before the agent responds so it's
    // visually clear which text is the user query vs agent output.
    printUserMessage(trimmed);
    try {
      await runTask(session, trimmed, controller.signal);
    } finally {
      running = false;
    }
    try {
      const status = await gitStatus(session.repoRoot);
      if (status && status !== "(clean)" && !status.startsWith("fatal:")) {
        console.log(c.dim("git status: ") + status.split("\n").slice(0, 5).join("\n"));
      }
    } catch {
      // Non-git directory — not fatal.
    }
    rl.prompt();
  }
}
