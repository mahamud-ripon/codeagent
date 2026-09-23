#!/usr/bin/env node
import "dotenv/config";
import path from "node:path";
import process from "node:process";
import { Agent } from "./agent/agent.js";
import { createProviderFromEnv } from "./llm/provider.js";
import { ensureEndpointForKey, loadGlobalEnv } from "./cli/config.js";
import { startRepl } from "./cli/repl.js";
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
  --model <id>            Model (default: $MODEL or gpt-5.6-luna)
  --max-iterations <n>    Max agent iterations (default: $MAX_ITERATIONS or 30)
  -r, --resume [id]       Resume latest session (or specified session ID / index)
  --sessions              List saved sessions for this repository and exit
  -h, --help              Show this help

REPL slash commands: /help /status /sessions /session /resume /new /key /model /provider /endpoint /repo /iterations /diff /compact /clear /exit

Examples:
  codeagent
  codeagent -r
  codeagent --resume ses_20260923_110000_abcd
  codeagent "Fix the failing test in this repository."
  codeagent "Add pagination to GET /users. Add tests." --repo ./my-app
`);
}

function parseArgs(argv: string[]): {
  task: string;
  repo: string;
  model?: string;
  maxIterations: number;
  resume?: string | boolean;
  showSessions?: boolean;
} {
  const rest: string[] = [];
  let repo = process.cwd();
  let model: string | undefined;
  let maxIterations = Number(process.env.MAX_ITERATIONS ?? 30);
  let resume: string | boolean | undefined;
  let showSessions = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") {
      printHelp();
      process.exit(0);
    } else if (a === "--repo" && i + 1 < argv.length) {
      repo = argv[++i]!;
    } else if (a.startsWith("--repo=")) {
      repo = a.slice("--repo=".length);
    } else if (a === "--model" && i + 1 < argv.length) {
      model = argv[++i]!;
    } else if (a.startsWith("--model=")) {
      model = a.slice("--model=".length);
    } else if (a === "--max-iterations" && i + 1 < argv.length) {
      maxIterations = Number(argv[++i]);
    } else if (a.startsWith("--max-iterations=")) {
      maxIterations = Number(a.slice("--max-iterations=".length));
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

  return { task: rest.join(" ").trim(), repo, model, maxIterations, resume, showSessions };
}

async function runOneShot(
  task: string,
  repoRoot: string,
  model: string | undefined,
  maxIterations: number,
): Promise<void> {
  for (const notice of ensureEndpointForKey({ model })) {
    console.log(pc.yellow(notice));
  }
  const { responder, info } = createProviderFromEnv(process.env, { model });
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
  const agent = new Agent({ repoRoot, model: info.model, maxIterations, responder, reporter });
  try {
    const result = await agent.run(task, { signal: controller.signal });
    console.log("");
    console.log(formatMarkdown(result.finalMessage));
    console.log("");

    const stats: string[] = [
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
      maxIterations: args.maxIterations,
      activeSession,
    });
    return;
  }

  await runOneShot(args.task, repoRoot, args.model, args.maxIterations);
}

main().catch((error) => {
  console.error("codeagent failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});

