#!/usr/bin/env node
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { Agent } from "./agent/agent.js";
import { PermissionManager } from "./agent/permissions.js";
import {
  loadHooksSettings,
  loadModelSettings,
  loadPermissionSettings,
  loadSandboxSettings,
} from "./agent/settings.js";
import {
  exitCodeForStopReason,
  parseOutputFormat,
  renderJsonResult,
  type OutputFormat,
} from "./cli/headless.js";
import type { AgentEvent } from "./llm/events.js";
import { createProviderFromEnv } from "./llm/provider.js";
import { DEFAULT_MODEL } from "./llm/provider.js";
import { ensureEndpointForKey, loadGlobalEnv } from "./cli/config.js";
import { startRepl } from "./cli/repl.js";
import { setSandboxMode } from "./tools/sandbox.js";
import {
  formatTimeAgo,
  listSessions,
  loadSession,
} from "./session/sessionManager.js";
import { ConsoleAgentReporter, formatMarkdown, pc } from "./cli/ui/index.js";

// dotenv/config above loads <cwd>/.env (per-project override).
// The global file fills whatever is still unset: configure once.
loadGlobalEnv();

// Production crash guards (Claude Code/Codex parity): never let a stray
// rejection or sync throw kill the process without a message. REPL stays
// alive; headless exits 1 with a clear error instead of a stack dump.
let crashGuardsInstalled = false;
export function installCrashGuards(): void {
  if (crashGuardsInstalled) return;
  crashGuardsInstalled = true;
  process.on("unhandledRejection", (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    console.error(
      `codeagent: unhandled async error (session preserved): ${msg}`,
    );
  });
  process.on("uncaughtException", (error) => {
    console.error(
      `codeagent failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  });
}

installCrashGuards();

/**
 * CLI keeps zero agent logic: parse args -> configure Agent -> run -> print.
 * The same Agent class will later back a VS Code extension via an
 * Agent Server (WebSocket/IPC) without changes to agent/ or tools/.
 */

function printHelp(): void {
  const defaultModel = process.env.MODEL ?? DEFAULT_MODEL;
  console.log(`codeagent — autonomous coding agent

Usage:
  codeagent                          Start interactive mode (REPL)
  codeagent "your task" [options]    Run one task and exit

Options:
  --repo <path>           Repository root (default: cwd)
  -m, --model <id>        Model (default: $MODEL or ${defaultModel})
  -p, --provider <name>   LLM backend: openai (Responses SSE) | chat (Completions) | anthropic | gemini
  -e, --endpoint <url>    OpenAI-compatible base URL (implies chat provider)
  -i, --iterations <n>    Max agent iterations (alias of --max-iterations)
  --max-iterations <n>    Max agent iterations (default: $MAX_ITERATIONS or 30)
  -s, --sandbox <mode>    Command execution: docker or local (default: local)
  -y, --auto              Bypass permission prompts for this run
  --dangerously-skip-permissions
                          Same as --auto. Required for unattended edits.
  --allowedTools <rules>  Comma-separated allow rules, e.g. Bash(npm test:*),Edit(src/**)
  --print                 Headless: run one task and print the result
  --output-format <fmt>   text (default), json, or stream-json
  --ui <mode>             Terminal UI: next (default, interactive) or legacy (plain)
  --detach                Run a task in the local supervisor and return its session ID
  --attach <session-id>   Reconnect to a durable run
  --acp                   Start the ACP stdio bridge (IDE integration)
  mcp <add|list|remove>   Manage MCP servers (see /mcp in REPL)
  -r, --resume [id]       Resume latest session (or specified session ID / index)
  -c, --continue [id]       Alias for --resume (continue where you left off)
  --sessions              List saved sessions for this repository and exit
  -h, --help              Show this help

REPL slash commands:
  /help /status /sessions /session /resume /new /undo /rewind /export /revert /checkpoints
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
  provider?: "openai" | "chat" | "anthropic" | "gemini";
  baseURL?: string;
  maxIterations: number;
  sandbox?: "docker" | "local";
  resume?: string | boolean;
  showSessions?: boolean;
  autoApprove?: boolean;
  dangerouslySkipPermissions?: boolean;
  allowedTools?: string[];
  printMode?: boolean;
  outputFormat?: OutputFormat;
  ui?: "legacy" | "next";
  acp?: boolean;
  mcpArgs?: string[];
}

export function parseArgs(argv: string[]): CliArgs {
  const rest: string[] = [];
  let repo = process.cwd();
  let model: string | undefined;
  let provider: "openai" | "chat" | "anthropic" | "gemini" | undefined;
  let baseURL: string | undefined;
  let maxIterations = Number(process.env.MAX_ITERATIONS ?? 30);
  let sandbox: "docker" | "local" | undefined;
  let resume: string | boolean | undefined;
  let showSessions = false;
  let autoApprove = false;
  let dangerouslySkipPermissions = false;
  const allowedTools: string[] = [];
  let printMode = false;
  let outputFormat: OutputFormat = "text";
  let ui: "legacy" | "next" | undefined;
  let acp = false;
  let mcpArgs: string[] | undefined;

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
      provider =
        (nextValue() as
          | "openai"
          | "chat"
          | "anthropic"
          | "gemini"
          | undefined) ?? provider;
    } else if (a.startsWith("--provider=") || a.startsWith("-p=")) {
      provider = a.slice(a.indexOf("=") + 1) as
        | "openai"
        | "chat"
        | "anthropic"
        | "gemini";
    } else if (a === "-e" || a === "--endpoint") {
      baseURL = nextValue() ?? baseURL;
    } else if (a.startsWith("--endpoint=") || a.startsWith("-e=")) {
      baseURL = a.slice(a.indexOf("=") + 1);
    } else if (a === "-i" || a === "--iterations" || a === "--max-iterations") {
      const v = nextValue();
      if (v !== undefined) maxIterations = Number(v);
    } else if (
      a.startsWith("--max-iterations=") ||
      a.startsWith("--iterations=") ||
      a.startsWith("-i=")
    ) {
      maxIterations = Number(a.slice(a.indexOf("=") + 1));
    } else if (a === "-s" || a === "--sandbox") {
      sandbox = (nextValue() as "docker" | "local" | undefined) ?? sandbox;
    } else if (a.startsWith("--sandbox=") || a.startsWith("-s=")) {
      sandbox = a.slice(a.indexOf("=") + 1) as "docker" | "local";
    } else if (
      a === "-y" ||
      a === "--yes" ||
      a === "--auto" ||
      a === "--auto-approve" ||
      a === "--dangerously-skip-permissions"
    ) {
      autoApprove = true;
      dangerouslySkipPermissions =
        a === "--dangerously-skip-permissions" || dangerouslySkipPermissions;
    } else if (a === "--allowedTools") {
      const value = nextValue();
      if (value)
        allowedTools.push(
          ...value
            .split(",")
            .map((part) => part.trim())
            .filter(Boolean),
        );
    } else if (a.startsWith("--allowedTools=")) {
      allowedTools.push(
        ...a
          .slice("--allowedTools=".length)
          .split(",")
          .map((part) => part.trim())
          .filter(Boolean),
      );
    } else if (a === "--print") {
      printMode = true;
    } else if (a === "--output-format") {
      outputFormat = parseOutputFormat(nextValue());
    } else if (a.startsWith("--output-format=")) {
      outputFormat = parseOutputFormat(a.slice("--output-format=".length));
    } else if (a === "--ui") {
      const v = nextValue();
      if (v === "next" || v === "legacy") ui = v;
    } else if (a.startsWith("--ui=")) {
      const v = a.slice("--ui=".length);
      if (v === "next" || v === "legacy") ui = v;
    } else if (a === "--acp") {
      acp = true;
    } else if (a === "mcp") {
      mcpArgs = argv.slice(i + 1);
      break;
    } else if (a === "--sessions") {
      showSessions = true;
    } else if (
      a === "-r" ||
      a === "--resume" ||
      a === "-c" ||
      a === "--continue"
    ) {
      if (i + 1 < argv.length && !argv[i + 1].startsWith("-")) {
        resume = argv[++i];
      } else {
        resume = true;
      }
    } else if (a.startsWith("--resume=")) {
      resume = a.slice("--resume=".length);
    } else if (a.startsWith("--continue=")) {
      resume = a.slice("--continue=".length);
    } else {
      rest.push(a);
    }
  }

  if (!Number.isFinite(maxIterations) || maxIterations < 1) {
    console.error("Error: --max-iterations must be a positive number.");
    process.exit(4);
  }
  if (
    provider !== undefined &&
    provider !== "openai" &&
    provider !== "chat" &&
    provider !== "anthropic" &&
    provider !== "gemini"
  ) {
    console.error(
      "Error: --provider must be 'openai', 'chat', 'anthropic', or 'gemini'.",
    );
    process.exit(4);
  }
  if (sandbox !== undefined && sandbox !== "docker" && sandbox !== "local") {
    console.error("Error: --sandbox must be 'docker' or 'local'.");
    process.exit(4);
  }

  return {
    task: rest.join(" ").trim(),
    repo,
    model,
    provider,
    baseURL,
    maxIterations,
    sandbox,
    resume,
    showSessions,
    autoApprove,
    dangerouslySkipPermissions,
    allowedTools,
    printMode,
    outputFormat,
    ui,
    acp,
    mcpArgs,
  };
}

interface OneShotOptions {
  model?: string;
  provider?: "openai" | "chat" | "anthropic" | "gemini";
  baseURL?: string;
  maxIterations: number;
  autoApprove?: boolean;
  allowedTools?: string[];
  outputFormat?: OutputFormat;
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
  const { responder, info, providerInstance, systemPrompt } =
    createProviderFromEnv(process.env, {
      model: opts.model,
      provider: opts.provider,
      baseURL: opts.baseURL,
    });
  const quiet =
    opts.outputFormat === "json" || opts.outputFormat === "stream-json";
  if (!quiet) {
    console.log("");
    console.log(`  ${pc.bold("Workspace:")}  ${pc.white(repoRoot)}`);
    console.log(
      `  ${pc.bold("Model:")}      ${pc.yellow(info.model)}${info.baseURL ? pc.dim(` (${info.baseURL})`) : ""}`,
    );
    console.log(`  ${pc.bold("Task:")}       ${pc.cyan(task)}`);
    console.log(pc.dim("  Tip: Ctrl+C cancels a running task."));
    console.log("");
  }

  const controller = new AbortController();
  process.on("SIGINT", () => {
    console.log(pc.yellow("\nCancelling... (finishing current tool call)"));
    controller.abort();
  });

  const settings = loadPermissionSettings(repoRoot);
  const modelSettings = loadModelSettings(repoRoot);
  const hooks = loadHooksSettings(repoRoot);
  const bypass = opts.autoApprove === true;
  const permissions = new PermissionManager({
    autoApprove: bypass,
    mode: bypass ? "bypass" : (settings.mode ?? "default"),
    allow: [...settings.allow, ...(opts.allowedTools ?? [])],
    deny: settings.deny,
    ask: settings.ask,
  });
  // ML-5: plan-role responder for headless plan-mode runs.
  const { resolveRoles } = await import("./llm/modelRouting.js");
  const roles = resolveRoles(modelSettings, info.model);
  let planResponder: import("./llm/client.js").Responder | undefined;
  if (roles.plan && roles.plan !== info.model) {
    try {
      planResponder = createProviderFromEnv(process.env, {
        model: roles.plan,
        provider: opts.provider,
        baseURL: opts.baseURL,
      }).responder;
    } catch {
      planResponder = undefined;
    }
  }
  // EX-3: UserPromptSubmit fires before the headless task (best-effort).
  if (hooks.UserPromptSubmit) {
    try {
      const { runHooks } = await import("./agent/hooks.js");
      await runHooks(hooks, "UserPromptSubmit", {
        prompt: task.slice(0, 4000),
      });
    } catch {
      // ignore
    }
  }
  const reporter = quiet ? undefined : new ConsoleAgentReporter(repoRoot);
  const onEvent =
    opts.outputFormat === "stream-json"
      ? (event: AgentEvent) => {
          if ("respond" in event) return;
          console.log(JSON.stringify(event));
        }
      : undefined;
  const agent = new Agent({
    repoRoot,
    model: info.model,
    maxIterations: opts.maxIterations,
    responder,
    providerInstance,
    systemPrompt,
    reporter,
    permissions,
    provider: opts.provider,
    baseURL: opts.baseURL,
    autoApprove: bypass,
    onEvent,
    summarizer:
      roles.fast && roles.fast !== info.model
        ? (() => {
            try {
              return createProviderFromEnv(process.env, {
                model: roles.fast,
                provider: opts.provider,
                baseURL: opts.baseURL,
              }).responder;
            } catch {
              return undefined;
            }
          })()
        : undefined,
    capabilitiesOverride: modelSettings.capabilities,
    modelRoles: roles,
    planResponder,
    smallModel: modelSettings.smallModel,
    hooks,
  });
  try {
    const startedAt = Date.now();
    const result = await agent.run(task, { signal: controller.signal });
    const tookSeconds = (Date.now() - startedAt) / 1000;
    if (opts.outputFormat === "json" || opts.outputFormat === "stream-json") {
      console.log(
        renderJsonResult({
          ok:
            result.stopReason !== "permission" &&
            result.stopReason !== "budget" &&
            result.stopReason !== "error" &&
            result.stopReason !== "stuck",
          stopReason: result.stopReason ?? "ok",
          finalMessage: result.finalMessage,
          iterations: result.iterations,
          modifiedFiles: result.modifiedFiles,
          usage: result.usage,
        }),
      );
      process.exit(exitCodeForStopReason(result.stopReason));
    }
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
      stats.push(
        `${pc.bold("tests:")} ${passed === result.testResults.length ? pc.green(`all ${passed} passed`) : pc.yellow(`${passed}/${result.testResults.length} passed`)}`,
      );
    }
    console.log(pc.dim("─".repeat(50)));
    console.log(`  ${stats.join(" · ")}`);
    console.log("");
    const code = exitCodeForStopReason(result.stopReason);
    if (code !== 0) process.exit(code);
  } catch (error) {
    reporter?.stop();
    if (controller.signal.aborted) {
      console.error(pc.yellow("\nRun cancelled."));
      process.exit(130);
    }
    console.error(
      pc.red(
        `\nAgent failed: ${error instanceof Error ? error.message : error}`,
      ),
    );
    process.exit(exitCodeForStopReason("error"));
  }
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function main(): Promise<void> {
  if (process.argv.includes("--runtime-supervisor")) {
    loadGlobalEnv();
    const { startSupervisor } = await import("./runtime/supervisor.js");
    const service = await startSupervisor();
    const stop = () => {
      void service.close().then(() => process.exit(0));
    };
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
    return;
  }

  const args = parseArgs(process.argv.slice(2));
  const repoRoot = path.resolve(args.repo);
  const { runtimeCli } = await import("./runtime/cli.js");
  if (await runtimeCli({ ...args, repo: repoRoot }, process.argv.slice(2)))
    return;

  if (args.acp) {
    const { startAcpServer } = await import("./integrations/acp.js");
    await startAcpServer(repoRoot, { autoApprove: args.autoApprove });
    return;
  }

  if (args.mcpArgs) {
    const { runMcpCli } = await import("./cli/mcpCli.js");
    await runMcpCli(args.mcpArgs, repoRoot);
    return;
  }

  // EX-5: plugin bundles (codeagent plugin <install|list|remove>).
  // `mcp` is parsed as mcpArgs above; plugin uses the same trailing-args shape.
  const rawArgv = process.argv.slice(2);
  if (rawArgv[0] === "plugin") {
    const { installPlugin, listPlugins, removePlugin } = await import(
      "./extensions/plugins.js"
    );
    const sub = rawArgv[1];
    if (sub === "list") {
      const names = await listPlugins();
      console.log(
        names.length
          ? `Plugins (${names.length}):\n${names.map((n) => `  - ${n}`).join("\n")}`
          : "No plugins installed (~/.codeagent/plugins).",
      );
      return;
    }
    if (sub === "install") {
      const url = rawArgv[2];
      const name = rawArgv[3];
      if (!url) {
        console.error("Usage: codeagent plugin install <git-url> [name]");
        process.exit(4);
      }
      const dir = await installPlugin(url, name);
      console.log(`Installed plugin → ${dir}`);
      return;
    }
    if (sub === "remove" || sub === "uninstall" || sub === "rm") {
      const name = rawArgv[2];
      if (!name) {
        console.error("Usage: codeagent plugin remove <name>");
        process.exit(4);
      }
      await removePlugin(name);
      console.log(`Removed plugin "${name}".`);
      return;
    }
    console.log("Usage: codeagent plugin <install|list|remove>");
    return;
  }

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
  // SF-7 wiring: CLI flag wins; otherwise settings sandbox.mode/image applies.
  const sandboxFromSettings = loadSandboxSettings(repoRoot);
  const wantSandbox = args.sandbox ?? sandboxFromSettings.mode;
  if (wantSandbox) {
    const res = await setSandboxMode(wantSandbox);
    console.log(
      res.success
        ? pc.green(`  ✔ ${res.message}`)
        : pc.yellow(`  ⚠ ${res.message}`),
    );
    if (sandboxFromSettings.image) {
      console.log(
        pc.dim(
          `  Sandbox image: ${sandboxFromSettings.image}${sandboxFromSettings.network === false ? " (network: none)" : ""}`,
        ),
      );
    }
  }

  if (args.printMode && !args.task) {
    args.task = await readStdin();
  }

  if (!args.task) {
    let activeSession = undefined;
    if (args.resume !== undefined) {
      const list = listSessions(repoRoot);
      if (typeof args.resume === "string" && args.resume) {
        const num = Number(args.resume);
        const targetId =
          !isNaN(num) && num >= 1 && num <= list.length
            ? list[num - 1].id
            : args.resume;
        const loaded = loadSession(targetId);
        if (loaded) {
          activeSession = loaded;
          console.log(
            `Resuming session ${loaded.id}: "${loaded.title}" (${Math.floor((loaded.history?.length ?? 0) / 2)} turn(s))`,
          );
        } else {
          console.warn(
            `Session "${args.resume}" not found. Starting fresh session.`,
          );
        }
      } else if (list.length > 0) {
        activeSession = list[0];
        console.log(
          `Resuming latest session ${activeSession.id}: "${activeSession.title}" (${Math.floor((activeSession.history?.length ?? 0) / 2)} turn(s))`,
        );
      } else {
        console.log(
          "No previous sessions found to resume. Starting fresh session.",
        );
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
      ui: args.ui,
    });
    return;
  }

  await runOneShot(args.task, repoRoot, {
    model: args.model,
    provider: args.provider,
    baseURL: args.baseURL,
    maxIterations: args.maxIterations,
    autoApprove: args.autoApprove,
    allowedTools: args.allowedTools,
    outputFormat: args.printMode
      ? (args.outputFormat ?? "text")
      : args.outputFormat,
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
    return (
      fs.realpathSync(process.argv[1]) ===
      fs.realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main().catch((error) => {
    console.error(
      "codeagent failed:",
      error instanceof Error ? error.message : error,
    );
    process.exit(1);
  });
}
