#!/usr/bin/env node
import "dotenv/config";
import path from "node:path";
import process from "node:process";
import { Agent } from "./agent/agent.js";
import { createProviderFromEnv } from "./llm/provider.js";
import { ensureEndpointForKey, loadGlobalEnv } from "./cli/config.js";
import { startRepl } from "./cli/repl.js";

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
  -h, --help              Show this help

REPL slash commands: /help /status /key /model /provider /endpoint /repo /iterations /diff /clear /exit

Examples:
  codeagent
  codeagent "Fix the failing test in this repository."
  codeagent "Add pagination to GET /users. Add tests." --repo ./my-app
`);
}

function parseArgs(argv: string[]): {
  task: string;
  repo: string;
  model?: string;
  maxIterations: number;
} {
  const rest: string[] = [];
  let repo = process.cwd();
  let model: string | undefined;
  let maxIterations = Number(process.env.MAX_ITERATIONS ?? 30);

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
    } else {
      rest.push(a);
    }
  }

  if (!Number.isFinite(maxIterations) || maxIterations < 1) {
    console.error("Error: --max-iterations must be a positive number.");
    process.exit(1);
  }

  return { task: rest.join(" ").trim(), repo, model, maxIterations };
}

async function runOneShot(
  task: string,
  repoRoot: string,
  model: string | undefined,
  maxIterations: number,
): Promise<void> {
  for (const notice of ensureEndpointForKey({ model })) {
    console.log(notice);
  }
  const { responder, info } = createProviderFromEnv(process.env, { model });
  console.log(`Repository: ${repoRoot}`);
  console.log(`Provider: ${info.kind}${info.baseURL ? ` (${info.baseURL})` : ""}`);
  console.log(`Model: ${info.model} | maxIterations: ${maxIterations}`);
  console.log(`Task: ${task}`);
  console.log("Tip: Ctrl+C cancels (best-effort between tool calls).");

  const controller = new AbortController();
  process.on("SIGINT", () => {
    console.log("\nCancelling... (finishing current tool call)");
    controller.abort();
  });

  const agent = new Agent({ repoRoot, model: info.model, maxIterations, responder });
  try {
    const result = await agent.run(task, { signal: controller.signal });
    console.log("\n\n=== RESULT ===\n");
    console.log(result.finalMessage);
    console.log("\n--- run stats ---");
    console.log(`iterations: ${result.iterations}`);
    console.log(
      `files changed: ${result.modifiedFiles.length ? result.modifiedFiles.join(", ") : "(none)"}`,
    );
    if (result.testResults.length > 0) {
      for (const t of result.testResults) {
        console.log(`test: [exit ${t.exitCode}] ${t.command}`);
      }
    }
  } catch (error) {
    if (controller.signal.aborted) {
      console.error("\nRun cancelled.");
      process.exit(130);
    }
    console.error("\nAgent failed:", error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const { task, repo, model, maxIterations } = parseArgs(process.argv.slice(2));

  if (!task) {
    // Industry-standard behavior: bare invocation opens interactive mode.
    await startRepl({ repoRoot: path.resolve(repo), model, maxIterations });
    return;
  }

  await runOneShot(task, path.resolve(repo), model, maxIterations);
}

main().catch((error) => {
  console.error("codeagent failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
