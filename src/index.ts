#!/usr/bin/env node
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { Agent } from "./agent/agent.js";
import { createProviderFromEnv } from "./llm/provider.js";
import { ensureEndpointForKey, loadGlobalEnv } from "./cli/config.js";
import { startRepl } from "./cli/repl.js";
import { setSandboxMode } from "./tools/sandbox.js";
import { formatTimeAgo, listSessions, loadSession } from "./session/sessionManager.js";
import { ConsoleAgentReporter, formatMarkdown, pc } from "./cli/ui/index.js";

// dotenv/config above loads <cwd>/.env (per-project override).
// The global file fills whatever is still unset: configure once.
loadGlobalEnv();

/**
 * CLI keeps zero agent logic: parse args -> configure Agent -> run -> print.
 * The same Agent class will later back a VS Code extension via an
 * Agent Server (WebSocket/IPC) without changes to agent/ or tools/.
 */

function printHelp(): void {
  console.log(`codeagent — autonomous coding agent

Usage:
  codeagent                          Start interactive mode (REPL)
  codeagent "your task" [options]    Run one task and exit

Options:
  --repo <path>           Repository root (default: cwd)
  -m, --model <id>        Model (default: $MODEL or gpt-5.6-luna)
  -p, --provider <name>   LLM backend: openai (Responses) or chat (Completions)
  -e, --endpoint <url>    OpenAI-compatible base URL (implies chat provider)
  -i, --iterations <n>    Max agent iterations (alias of --max-iterations)
  --max-iterations <n>    Max agent iterations (default: $MAX_ITERATIONS or 30)
  -s, --sandbox <mode>    Command execution: docker or local (default: local)
  -y, --auto              Auto mode: auto-approve shell commands without prompt
  -r, --resume [id]       Resume latest session (or specified session ID / index)
  --sessions              List saved sessions for this repository and exit
  -h, --help              Show this help

REPL slash commands:
  /help /status /sessions /session /resume /new /undo /revert /checkpoints
  /repo /model /provider /endpoint /key /sandbox /iterations /plan /todos
  /tasks /mode /auto /manual /worktree /thought /t /diff /compact /clear /exit /quit

Examples:
  codeagent
  codeagent -y
  codeagent -r
  codeagent --resume ses_20260923_110000_abcd
  codeagent "Fix the failing test in this repository."
  codeagent "Add pagination to GET /users. Add tests." --repo ./my-app
  codeagent "Refactor auth." -m openai/gpt-oss-20b -p chat -e https://api.groq.com/openai/v1
  codeagent "Run the migration." -s docker
`);
}

export interface CliArgs {
  task: string;
  repo: string;
  model?: string;
  provider?: "openai" | "chat";
  baseURL?: string;
  maxIterations: number;
  sandbox?: "docker" | "local";
  resume?: string | boolean;
  showSessions?: boolean;
  autoApprove?: boolean;
}

export function parseArgs(argv: string[]): CliArgs {
  const rest: string[] = [];
  let repo = process.cwd();
  let model: string | undefined;
  let provider: "openai" | "chat" | undefined;
  let baseURL: string | undefined;
  let maxIterations = Number(process.env.MAX_ITERATIONS ?? 30);
  let sandbox: "docker" | "local" | undefined;
  let resume: string | boolean | undefined;
  let showSessions = false;
  let autoApprove = false;

  let i = 0;
  // Consumes the next argv token as the current flag's value, if present.
  const nextValue = (): string | undefined => {
    if (argv[i + 1] !== undefined && !argv[i + 1].startsWith("-")) {
      return argv[++i];
    }
    return undefined;
  };

  for (i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") {
      printHelp();
      process.exit(0);
    } else if (a === "--repo" && i + 1 < argv.length) {
      repo = argv[++i]!;
    } else if (a.startsWith("--repo=")) {
      repo = a.slice("--repo=".length);
    } else if (a === "-m" || a === "--model") {
      model = nextValue() ?? model;
    } else if (a.startsWith("--model=") || a.startsWith("-m=")) {
      model = a.slice(a.indexOf("=") + 1);
    } else if (a === "-p" || a === "--provider") {
      provider = nextValue() as "openai" | "chat" | undefined ?? provider;
    } else if (a.startsWith("--provider=") || a.startsWith("-p=")) {
      provider = a.slice(a.indexOf("=") + 1) as "openai" | "chat";
    } else if (a === "-e" || a === "--endpoint") {
      baseURL = nextValue() ?? baseURL;
    } else if (a.startsWith("--endpoint=") || a.startsWith("-e=")) {
      baseURL = a.slice(a.indexOf("=") + 1);
    } else if (a === "-i" || a === "--iterations" || a === "--max-iterations") {
      const v = nextValue();
      if (v !== undefined) maxIterations = Number(v);
    } else if (a.startsWith("--max-iterations=") || a.startsWith("--iterations=") || a.startsWith("-i=")) {
      maxIterations = Number(a.slice(a.indexOf("=") + 1));
    } else if (a === "-s" || a === "--sandbox") {
      sandbox = nextValue() as "docker" | "local" | undefined ?? sandbox;
    } else if (a.startsWith("--sandbox=") || a.startsWith("-s=")) {
      sandbox = a.slice(a.indexOf("=") + 1) as "docker" | "local";
    } else if (a === "-y" || a === "--yes" || a === "--auto" || a === "--auto-approve") {
      autoApprove = true;
    } else if (a === "--sessions") {
      showSessions = true;
    } else if (a === "-r" || a === "--resume") {
      if (i + 1 < argv.length && !argv[i + 1].startsWith("-")) {
        resume = argv[++i];
      } else {
        resume = true;
      }
    } else if (a.startsWith("--resume=")) {
      resume = a.slice("--resume=".length);
    } else {
      rest.push(a);
    }
  }

  if (!Number.isFinite(maxIterations) || maxIterations < 1) {
    console.error("Error: --max-iterations must be a positive number.");
    process.exit(1);
  }
  if (provider !== undefined && provider !== "openai" && provider !== "chat") {
    console.error("Error: --provider must be 'openai' or 'chat'.");
    process.exit(1);
  }
  if (sandbox !== undefined && sandbox !== "docker" && sandbox !== "local") {
    console.error("Error: --sandbox must be 'docker' or 'local'.");
    process.exit(1);
  }

  return { task: rest.join(" ").trim(), repo, model, provider, baseURL, maxIterations, sandbox, resume, showSessions, autoApprove };
}

interface OneShotOptions {
  model?: string;
  provider?: "openai" | "chat";
  baseURL?: string;
  maxIterations: number;
}

async function runOneShot(
  task: string,
  repoRoot: string,
  opts: OneShotOptions,
): Promise<void> {
  for (const notice of ensureEndpointForKey({
    provider: opts.provider,
    baseURL: opts.baseURL,
    model: opts.model,
  })) {
    console.log(pc.yellow(notice));
  }
  const { responder, info } = createProviderFromEnv(process.env, {
    model: opts.model,
    provider: opts.provider,
    baseURL: opts.baseURL,
  });
  console.log("");
  console.log(`  ${pc.bold("Workspace:")}  ${pc.white(repoRoot)}`);
  console.log(`  ${pc.bold("Model:")}      ${pc.yellow(info.model)}${info.baseURL ? pc.dim(` (${info.baseURL})`) : ""}`);
  console.log(`  ${pc.bold("Task:")}       ${pc.cyan(task)}`);
  console.log(pc.dim("  Tip: Ctrl+C cancels a running task."));
  console.log("");

  const controller = new AbortController();
  process.on("SIGINT", () => {
    console.log(pc.yellow("\nCancelling... (finishing current tool call)"));
    controller.abort();
  });

  const reporter = new ConsoleAgentReporter(repoRoot);
  const agent = new Agent({ repoRoot, model: info.model, maxIterations: opts.maxIterations, responder, reporter });
  try {
    const startedAt = Date.now();
    const result = await agent.run(task, { signal: controller.signal });
    const tookSeconds = (Date.now() - startedAt) / 1000;
    console.log("");
    console.log(formatMarkdown(result.finalMessage));
    console.log("");

    const stats: string[] = [
      `${pc.bold("took:")} ${pc.cyan(`${tookSeconds.toFixed(1)}s`)}`,
      `${pc.bold("iterations:")} ${pc.cyan(String(result.iterations))}`,
      `${pc.bold("files:")} ${result.modifiedFiles.length ? pc.green(result.modifiedFiles.join(", ")) : pc.dim("(none)")}`,
    ];
    if (result.testResults.length > 0) {
      const passed = result.testResults.filter((t) => t.exitCode === 0).length;
      stats.push(`${pc.bold("tests:")} ${passed === result.testResults.length ? pc.green(`all ${passed} passed`) : pc.yellow(`${passed}/${result.testResults.length} passed`)}`);
    }
    console.log(pc.dim("─".repeat(50)));
    console.log(`  ${stats.join(" · ")}`);
    console.log("");
  } catch (error) {
    reporter.stop();
    if (controller.signal.aborted) {
      console.error(pc.yellow("\nRun cancelled."));
      process.exit(130);
    }
    console.error(pc.red(`\nAgent failed: ${error instanceof Error ? error.message : error}`));
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = path.resolve(args.repo);

  if (args.showSessions) {
    const list = listSessions(repoRoot);
    if (list.length === 0) {
      console.log(`No saved sessions found for ${repoRoot}`);
      return;
    }
    console.log(`Saved sessions for ${repoRoot}:`);
    list.forEach((s, idx) => {
      const age = `(${formatTimeAgo(s.updatedAt)}, ${s.turnCount} turns)`;
      console.log(`  ${idx + 1}. ${s.id} ${age} - ${s.title}`);
    });
    return;
  }

  // Apply the sandbox preference up-front (health check included) so both
  // one-shot and REPL modes run commands through the chosen runner.
  if (args.sandbox) {
    const res = await setSandboxMode(args.sandbox);
    console.log(res.success ? pc.green(`  ✔ ${res.message}`) : pc.yellow(`  ⚠ ${res.message}`));
  }

  if (!args.task) {
    let activeSession = undefined;
    if (args.resume !== undefined) {
      const list = listSessions(repoRoot);
      if (typeof args.resume === "string" && args.resume) {
        const num = Number(args.resume);
        const targetId = !isNaN(num) && num >= 1 && num <= list.length ? list[num - 1].id : args.resume;
        const loaded = loadSession(targetId);
        if (loaded) {
          activeSession = loaded;
          console.log(`Resuming session ${loaded.id}: "${loaded.title}" (${Math.floor((loaded.history?.length ?? 0) / 2)} turn(s))`);
        } else {
          console.warn(`Session "${args.resume}" not found. Starting fresh session.`);
        }
      } else if (list.length > 0) {
        activeSession = list[0];
        console.log(`Resuming latest session ${activeSession.id}: "${activeSession.title}" (${Math.floor((activeSession.history?.length ?? 0) / 2)} turn(s))`);
      } else {
        console.log("No previous sessions found to resume. Starting fresh session.");
      }
    }

    // Industry-standard behavior: bare invocation opens interactive mode.
    await startRepl({
      repoRoot,
      model: args.model,
      provider: args.provider,
      baseURL: args.baseURL,
      maxIterations: args.maxIterations,
      activeSession,
      autoApprove: args.autoApprove,
    });
    return;
  }

  await runOneShot(args.task, repoRoot, {
    model: args.model,
    provider: args.provider,
    baseURL: args.baseURL,
    maxIterations: args.maxIterations,
  });
}

// Run only when executed directly (node dist/index.js / tsx src/index.ts),
// not when imported (e.g. by tests importing parseArgs). Both sides must be
// realpath-resolved: npm-linked bins invoke dist via a symlink/junction, and
// Node resolves import.meta.url to the real path, so a naive URL comparison
// would silently skip main() for globally installed commands.
const invokedDirectly = (() => {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main().catch((error) => {
    console.error("codeagent failed:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
}

