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

export interface SessionConfig {
  repoRoot: string;
  model?: string;
  provider?: string;
  baseURL?: string;
  maxIterations: number;
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

// Minimal ANSI styling, no dependencies.
const c = {
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
};

function readVersion(): string {
  try {
    // src/cli/repl.ts and dist/cli/repl.js both sit two levels below root.
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkgPath = path.resolve(here, "..", "..", "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
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
  console.log("");
  console.log(`  ${c.bold(c.cyan("▲ Codeagent"))} ${c.dim(`v${readVersion()}`)}`);
  console.log(`  ${c.dim(info.model)} · ${c.dim(info.kind === "openai-chat" ? "chat" : "responses")}${info.baseURL ? c.dim(` · ${info.baseURL}`) : ""}`);
  console.log(`  ${c.dim(session.repoRoot)}`);
  if (info.needsKey) {
    console.log(`  ${c.yellow("Not configured · run /key <api-key> (no key needed for local Ollama)")}`);
  }
  console.log(c.dim("─".repeat(60)));
  console.log(`  ${c.dim('Type a task, or "/help" for commands. Ctrl+C cancels a run.')} `);
  console.log("");
}

function printHelp(): void {
  console.log(`
  ${c.bold("Slash commands:")}
    /help                 Show this help
    /status               Show repo / provider / model / session settings
    /key <api-key>        Save key globally (~/.codeagent/.env) — configure once
    /key --local <k>      Save key to <repo>/.env (per-project override)
    /model <id>           Switch model (e.g. /model openai/gpt-oss-20b)
    /provider <name>      Switch backend: openai | chat
    /endpoint <url>       Set OpenAI-compatible base URL (implies chat); "off" clears
    /repo <path>          Switch repository root
    /iterations <n>       Set max iterations for subsequent runs
    /diff                 Show current git diff
    /clear                Clear the screen
    /exit, /quit          Leave codeagent
`);
}

function printStatus(session: SessionConfig): void {
  const info = describeProviderFromEnv(process.env, sessionOverrides(session));
  console.log(`
  ${c.bold("Session:")}
    repo ......... ${session.repoRoot}
    provider ..... ${info.kind}${info.baseURL ? ` (${info.baseURL})` : ""}
    model ........ ${info.model}
    maxIterations  ${session.maxIterations}
    api key ...... ${info.needsKey ? c.yellow("missing — run /key <api-key>") : c.green("configured")}
`);
}

async function runTask(session: SessionConfig, task: string, signal: AbortSignal): Promise<void> {
  // Heal keys saved before auto-detect existed (or pasted into .env by hand).
  for (const notice of ensureEndpointForKey({
    provider: session.provider,
    baseURL: session.baseURL,
    model: session.model,
  })) {
    console.log(c.yellow(notice));
  }
  let provider;
  try {
    provider = createProviderFromEnv(process.env, sessionOverrides(session));
  } catch (error) {
    if (error instanceof MissingApiKeyError) {
      console.error(c.yellow(`\n${error.message}\n`));
      return;
    }
    throw error;
  }
  const { responder, info } = provider;
  console.log(c.dim(`— ${info.model} · ${session.repoRoot} —`));
  const agent = new Agent({
    repoRoot: session.repoRoot,
    model: info.model,
    maxIterations: session.maxIterations,
    responder,
  });
  try {
    const result = await agent.run(task, { signal });
    console.log(`\n${c.bold(c.green("=== RESULT ==="))}\n`);
    console.log(result.finalMessage);
    console.log(c.dim(`\niterations: ${result.iterations} · files: ${result.modifiedFiles.join(", ") || "(none)"}`));
  } catch (error) {
    if (signal.aborted) {
      console.log(c.yellow("\nRun cancelled."));
      return;
    }
    console.error(c.red(`\nAgent failed: ${error instanceof Error ? error.message : error}`));
  }
}

export async function startRepl(initial: SessionConfig): Promise<void> {
  const session: SessionConfig = { ...initial };
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
    prompt: c.bold("> "),
  });
  loadHistory(rl);

  let running = false;
  let controller = new AbortController();
  let sigintCount = 0;

  // Manual SIGINT handling: cancel run first, exit only when idle.
  rl.on("SIGINT", () => {
    if (running) {
      console.log(c.yellow("\nCancelling... (finishing current tool call)"));
      controller.abort();
      return;
    }
    sigintCount++;
    if (sigintCount >= 2) {
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
            console.log(await gitDiff(session.repoRoot));
          } catch (error) {
            console.error(c.red(`git diff failed: ${error instanceof Error ? error.message : error}`));
          }
          break;
        case "clear":
          console.clear();
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

    // Plain text = a task. Await it so prompts don't interleave.
    running = true;
    controller = new AbortController();
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
