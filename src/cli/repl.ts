import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { Agent } from "../agent/agent.js";
import {
  createProviderFromEnv,
  describeProviderFromEnv,
  MissingApiKeyError,
  type ProviderOverrides,
} from "../llm/provider.js";
import { gitDiff, gitStatus, restoreShadowCheckpoint } from "../tools/git.js";
import { deleteEnvKey, ensureEndpointForKey, globalEnvPath, upsertEnvKey } from "./config.js";

// Re-exported for existing callers/tests; canonical home is ./config.js.
export { detectEndpointForKey } from "./config.js";

/**
 * Interactive REPL (Claude-Code style): `codeagent` with no task drops
 * here instead of exiting. Thin layer over the same Agent core as
 * one-shot mode — zero agent logic lives in this file.
 */

import { PermissionManager } from "../agent/permissions.js";
import { loadModelSettings, loadPermissionSettings } from "../agent/settings.js";
import { compactHistory, compactHistoryWithSummary } from "../agent/compactor.js";
import { logAudit } from "../agent/audit.js";
import { appendMemoryNote, generateMemoryFile } from "../agent/rules.js";
import { CheckpointManager } from "../agent/checkpoint.js";
import { getSandboxMode, setSandboxMode } from "../tools/sandbox.js";
import {
  appendSessionTurn,
  createSession,
  defaultExportFilename,
  deleteSession,
  deriveTitle,
  dropTurnsFrom,
  exportSessionMarkdown,
  formatTimeAgo,
  listSessions,
  loadSession,
  resolveRewindTarget,
  rewriteSessionHistory,
  saveSession,
  truncateHistoryForRewind,
  type RewindScope,
  type SessionRecord,
} from "../session/sessionManager.js";
import {
  renderBanner,
  ConsoleAgentReporter,
  formatMarkdown,
  formatDiff,
  promptPermission,
  promptPlanApproval,
  promptRewindSelect,
  promptSessionSelect,
  printUserMessage,
  formatThoughtLine,
  formatTurnCompletionLine,
  renderJumpToBottomBadge,
  renderStatusDock,
  latestThought,
  pc,
  icons,
} from "./ui/index.js";
import { estimateCostUsd, getModelCapabilities } from "../llm/capabilities.js";
import type { Responder } from "../llm/client.js";
import { TodoManager } from "../agent/todo.js";
import { PlanModeManager } from "../agent/planMode.js";
import { FileStateCache } from "../tools/fileStateCache.js";
import { createWorktree, hasWorktreeModifications, resolveMainRootFromWorktree } from "../tools/worktree.js";
import { renderTodoList } from "./ui/reporter.js";

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
  todoManager?: TodoManager;
  planModeManager?: PlanModeManager;
  fileStateCache?: FileStateCache;
  isWorktree?: boolean;
  /** Original repository root, captured before switching into an isolated worktree. */
  mainRepoRoot?: string;
  /** Reference to the reporter of the currently running task (for live view toggles). */
  activeReporter?: ConsoleAgentReporter;
  /** Whether the sticky todo list renders expanded (true) or as a compact one-liner (false). */
  todosExpanded?: boolean;
  /** Storage directory override for saved sessions (defaults to the real home). */
  sessionHome?: string;
  /** Whether commands are auto-approved without confirmation (Auto Mode). */
  autoApprove?: boolean;
  /** Cumulative token/cost usage for this REPL session (powers /cost). */
  usage?: { input: number; output: number; costUsd: number };
  /** UI selector (UI-1…UI-13): legacy readline (default) or next streaming UI. */
  ui?: "legacy" | "next";
  /**
   * Plan-mode approver (AG-9): shows exit_plan_mode plans and requires
   * accept / edit / reject. A returned string is the user-revised plan.
   */
  planApprover?: (plan: string) => Promise<boolean | string>;
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

const HISTORY_CAP = 200;

function saveHistory(line: string): void {
  if (isSensitiveLine(line)) return; // never persist secrets
  try {
    const file = historyPath();
    let existing: string[] = [];
    try {
      existing = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
    } catch {
      // First write to a fresh history file.
    }
    existing.push(line);
    // Bound the file: once it grows past 2x the cap, rewrite trimmed to the cap.
    if (existing.length > HISTORY_CAP * 2) {
      fs.writeFileSync(file, existing.slice(-HISTORY_CAP).join("\n") + "\n");
    } else {
      fs.appendFileSync(file, line + "\n");
    }
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
    ${pc.cyan("/rewind [n] [scope]")}     Restore code, conversation, or both to an earlier turn
    ${pc.cyan("/export [file]")}          Export this session to Markdown
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

  ${pc.bold(pc.cyan("Agent Mechanisms & Planning:"))}
    ${pc.cyan("/plan [on|off]")}          Toggle Dual-Phase Plan Mode (locks modifications for exploration)
    ${pc.cyan("/todos, /tasks")}          Display or toggle current live tasks & progress (Ctrl+T)
    ${pc.cyan("/worktree [slug]")}        Manage isolated Git worktrees (sandbox execution)

  ${pc.bold(pc.cyan("Context & Code Inspection:"))}
    ${pc.cyan("/thought [on|off]")}       Toggle thinking display (Ctrl+O, alias: /t)
    ${pc.cyan("/diff")}                   Show colorized git diff
    ${pc.cyan("/compact [focus]")}        Compact conversation memory to reduce token usage
    ${pc.cyan("/cost")}                   Show session token and cost totals
    ${pc.cyan("/init")}                   Generate the project memory file (AGENTS.md)
    ${pc.cyan("# note")}                  Append a note to the project memory file
    ${pc.cyan("/status")}                 Show repo / provider / model / session settings
    ${pc.cyan("/clear")}                  Clear the screen and reset session conversation memory
    ${pc.cyan("/help")}                   Show this help menu
    ${pc.cyan("/exit, /quit")}            Leave codeagent
`);
}

function printStatus(session: SessionConfig): void {
  const info = describeProviderFromEnv(process.env, sessionOverrides(session));
  const turnCount = session.history && session.history.length > 0 ? Math.floor(session.history.length / 2) : 0;
  const isAuto = session.permissions?.isAutoApprove() ?? session.autoApprove ?? false;
  const roles = loadModelSettings(session.repoRoot);
  console.log(`
  ${pc.bold(pc.cyan("Session Status"))}
  ${pc.dim("─".repeat(45))}
  ${pc.bold("ID:")}            ${session.activeSession?.id ? pc.cyan(session.activeSession.id) : pc.dim("none")}
  ${pc.bold("Title:")}         ${session.activeSession?.title ? pc.white(session.activeSession.title) : pc.dim("none")}
  ${pc.bold("Workspace:")}     ${session.repoRoot}${session.isWorktree ? pc.yellow(" (isolated worktree)") : ""}
  ${pc.bold("Plan Mode:")}     ${session.planModeManager?.isActive() ? pc.cyan("ACTIVE (read-only exploration)") : pc.dim("normal (execution)")}
  ${pc.bold("Execution Mode:")} ${isAuto ? pc.green("auto (auto-approves commands)") : pc.cyan("manual (prompts for confirmation)")}
  ${pc.bold("Todo Tasks:")}    ${session.todoManager && session.todoManager.getTodos().length > 0 ? `${session.todoManager.getTodos().length} tasks (${session.todoManager.getTodos().filter((t) => t.status === "completed").length} completed)` : pc.dim("none")}
  ${pc.bold("Provider:")}      ${pc.magenta(info.kind)}${info.baseURL ? pc.dim(` (${info.baseURL})`) : ""}
  ${pc.bold("Model:")}         ${pc.yellow(info.model)}${roles.fast ? pc.dim(` (fast: ${roles.fast}${roles.plan ? `, plan: ${roles.plan}` : ""})`) : ""}
  ${pc.bold("Max Iter:")}      ${pc.white(String(session.maxIterations))}
  ${pc.bold("API Key:")}       ${info.needsKey ? pc.yellow("missing — run /key <api-key>") : pc.green("configured")}
  ${pc.bold("Context Memory:")} ${turnCount > 0 ? pc.green(`${turnCount} turn(s) in context`) : pc.dim("empty")}
`);
}

function formatUsd(value: number): string {
  return value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}

/** Session token/cost totals for /cost (ML-6). */
export function printCost(session: SessionConfig): void {
  const info = describeProviderFromEnv(process.env, sessionOverrides(session));
  const usage = session.usage ?? { input: 0, output: 0, costUsd: 0 };
  const caps = getModelCapabilities(info.model);
  const priced = caps.inputPricePerMtok !== undefined && caps.outputPricePerMtok !== undefined;
  console.log(`
  ${pc.bold(pc.cyan("Session Cost"))}
  ${pc.dim("─".repeat(45))}
  ${pc.bold("Model:")}         ${pc.yellow(info.model)}
  ${pc.bold("Input tokens:")}  ${pc.white(usage.input.toLocaleString())}
  ${pc.bold("Output tokens:")} ${pc.white(usage.output.toLocaleString())}
  ${pc.bold("Cost:")}          ${priced ? pc.green(formatUsd(usage.costUsd)) : pc.dim(`${formatUsd(usage.costUsd)} (price unknown for this model)`)}
  ${pc.bold("Budgets:")}       ${pc.dim("set per-run caps with --max-iterations; token/cost budgets stop the loop (stopReason: budget)")}
`);
}

/** SS-4: fast-model title with deterministic fallback. Never throws. */
async function resolveAutoTitle(task: string, summarizer?: Responder): Promise<string> {
  const fallback = deriveTitle(task);
  if (!summarizer) return fallback;
  try {
    const res = await summarizer([
      { role: "user", content: `Write a 2-6 word session title for this task. No quotes. Task: ${task.slice(0, 200)}` },
    ]);
    const t = (res.output_text ?? "")
      .trim()
      .split("\n")[0]
      .replace(/^["'#\-*\s]+|["'\s]+$/g, "")
      .trim()
      .slice(0, 60);
    return t || fallback;
  } catch {
    return fallback;
  }
}

async function runTask(
  session: SessionConfig,
  task: string,
  signal: AbortSignal,
  turn?: { historyStart: number; checkpointId?: string; checkpointHash?: string },
): Promise<void> {
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
  session.todoManager = session.todoManager ?? new TodoManager();
  session.todoManager.clearIfAllCompleted();
  session.planModeManager = session.planModeManager ?? new PlanModeManager();
  session.fileStateCache = session.fileStateCache ?? new FileStateCache();

  // Model roles + capability overrides (ML-3/ML-5): the fast role backs
  // LLM-written compaction summaries; window overrides rescale compaction.
  const modelSettings = loadModelSettings(session.repoRoot);
  let summarizer: Responder | undefined;
  if (modelSettings.fast && modelSettings.fast !== info.model) {
    try {
      summarizer = createProviderFromEnv(process.env, {
        ...sessionOverrides(session),
        model: modelSettings.fast,
      }).responder;
    } catch {
      summarizer = undefined;
    }
  }

  const isAuto = session.permissions?.isAutoApprove() ?? session.autoApprove ?? false;
  const reporter = new ConsoleAgentReporter(session.repoRoot, session.autoExpandThought, session.todoManager?.getTodos());
  reporter.setTodosExpanded(session.todosExpanded ?? true);
  reporter.setIsAutoMode?.(isAuto);
  reporter.startTask();
  session.activeReporter = reporter;
  const agent = new Agent({
    repoRoot: session.repoRoot,
    model: info.model,
    maxIterations: session.maxIterations,
    responder,
    permissions: session.permissions,
    reporter,
    todoManager: session.todoManager,
    planModeManager: session.planModeManager,
    fileStateCache: session.fileStateCache,
    provider: session.provider,
    baseURL: session.baseURL,
    autoApprove: session.autoApprove,
    planApprover: session.planApprover,
    summarizer,
    capabilitiesOverride: modelSettings.capabilities,
  });
  try {
    const taskStartedAt = Date.now();
    const result = await agent.run(task, { signal, history: session.history });
    const tookSeconds = (Date.now() - taskStartedAt) / 1000;
    if (result.usage) {
      const total = session.usage ?? { input: 0, output: 0, costUsd: 0 };
      // Fill cost gaps when the provider omitted usage but the price table knows the model.
      let cost = result.usage.costUsd;
      if (!cost) {
        cost = estimateCostUsd(info.model, result.usage.input, result.usage.output) ?? 0;
      }
      session.usage = {
        input: total.input + result.usage.input,
        output: total.output + result.usage.output,
        costUsd: total.costUsd + cost,
      };
    }
    if (result.history) {
      session.history = compactHistory(result.history);
    }
    // Auto-save the active session on disk (SS-1/SS-3/SS-4):
    // per-turn checkpoint index + append-only JSONL turn + fast-model title.
    if (session.activeSession) {
      const beforeLen = turn?.historyStart ?? 0;
      const afterHistory = session.history ?? [];
      const needsTitle =
        session.activeSession.title === "New session" || !session.activeSession.title;
      const title = needsTitle ? await resolveAutoTitle(task, summarizer) : undefined;
      if (title) session.activeSession.title = title;
      const newFiles = result.modifiedFiles.filter(
        (f) => !session.activeSession!.modifiedFiles.includes(f),
      );
      const checkpoint =
        turn?.checkpointId
          ? {
              id: turn.checkpointId,
              timestamp: Date.now(),
              label: task.slice(0, 80),
              commitHash: turn.checkpointHash ?? "",
            }
          : undefined;
      if (afterHistory.length < beforeLen) {
        // Compaction rewrote history: record a rewrite line so JSONL replay
        // stays exact, then record the turn marker without duplicating text.
        session.activeSession.history = afterHistory;
        session.activeSession.turnCount++;
        for (const f of result.modifiedFiles) {
          if (!session.activeSession.modifiedFiles.includes(f)) {
            session.activeSession.modifiedFiles.push(f);
          }
        }
        if (checkpoint && !session.activeSession.checkpoints?.some((c) => c.id === checkpoint.id)) {
          session.activeSession.checkpoints = [...(session.activeSession.checkpoints ?? []), checkpoint];
        }
        session.activeSession.model = info.model;
        session.activeSession.provider = session.provider;
        session.activeSession.baseURL = session.baseURL;
        rewriteSessionHistory(session.activeSession, afterHistory, session.sessionHome);
        const snap = {
          index: (session.activeSession.turns?.length ?? 0) + 1,
          timestamp: new Date().toISOString(),
          label: task.slice(0, 120),
          historyStart: 0,
          historyLength: afterHistory.length,
          checkpointId: checkpoint?.id,
        };
        session.activeSession.turns = [...(session.activeSession.turns ?? []), snap];
        saveSession(session.activeSession, session.sessionHome);
      } else {
        appendSessionTurn(
          session.activeSession,
          {
            label: task.slice(0, 120),
            historyAppend: afterHistory.slice(beforeLen),
            historyStart: beforeLen,
            checkpoint,
            title,
            modifiedFilesAppend: newFiles,
            model: info.model,
            provider: session.provider,
            baseURL: session.baseURL,
          },
          session.sessionHome,
        );
        session.history = session.activeSession.history;
      }
    }

    // Rich formatted assistant response
    console.log("");
    console.log(formatMarkdown(result.finalMessage));
    console.log("");

    // Point 7: Jump to bottom badge if response is long
    if (result.finalMessage.split("\n").length > 15) {
      console.log(renderJumpToBottomBadge());
      console.log("");
    }

    // Point 6: Claude Code completion line: * Cooked for 2m 10s · done 10:13 PM
    const durationMs = Date.now() - taskStartedAt;
    console.log(formatTurnCompletionLine(durationMs));
    console.log("");

    if (session.todoManager) {
      const activeTodos = session.todoManager.getTodos();
      if (activeTodos.length > 0) {
        console.log(`${renderTodoList(activeTodos)}\n`);
      }
    }
  } catch (error) {
    reporter.stop();
    if (signal.aborted) {
      console.log(pc.yellow("\nRun cancelled."));
      return;
    }
    console.error(pc.red(`\nAgent failed: ${error instanceof Error ? error.message : error}`));
  }
}


/**
 * SS-2: rewind to a turn. Scope "code" restores files only, "conversation"
 * truncates history only, "both" (default) does both. Exported for tests.
 */
export async function doRewind(
  session: SessionConfig,
  selector: string,
  scope: RewindScope = "both",
): Promise<{ ok: boolean; message: string }> {
  const record = session.activeSession;
  if (!record) return { ok: false, message: "No active session to rewind." };
  const turns = record.turns ?? [];
  if (turns.length === 0) return { ok: false, message: "No turns recorded yet — nothing to rewind." };
  const target = resolveRewindTarget(turns, selector);
  if (!target) return { ok: false, message: `No such turn: "${selector}". Use /rewind with no args to pick.` };

  const wantCode = scope === "both" || scope === "code";
  const wantConversation = scope === "both" || scope === "conversation";

  if (wantCode) {
    if (!target.checkpointId) {
      return { ok: false, message: `Turn ${target.index} has no code checkpoint (non-git workspace?).` };
    }
    let restored = false;
    if (session.checkpoints) {
      restored = await session.checkpoints.restoreCheckpoint(target.checkpointId);
    }
    if (!restored) {
      restored = await restoreShadowCheckpoint(session.repoRoot, target.checkpointId);
    }
    if (!restored) {
      return { ok: false, message: `Checkpoint ${target.checkpointId} could not be restored.` };
    }
    // Sync the persisted checkpoint index with the manager state.
    if (session.checkpoints) {
      const remaining = session.checkpoints.listCheckpoints().map((c) => ({ ...c }));
      record.checkpoints = remaining;
    } else {
      record.checkpoints = (record.checkpoints ?? []).filter(
        (c) => (turns.findIndex((t) => t.checkpointId === c.id) < target.index - 1) || c.id === target.checkpointId,
      );
    }
  }

  if (wantConversation) {
    const history = session.history ?? record.history ?? [];
    session.history = truncateHistoryForRewind(history, target);
    record.history = session.history;
    record.turns = dropTurnsFrom(turns, target.index);
    record.turnCount = record.turns.length;
  } else {
    // Code-only rewind still drops later turn markers so a second rewind
    // cannot target code that no longer exists; history is untouched.
    record.turns = dropTurnsFrom(turns, target.index);
    record.turnCount = record.turns.length;
  }

  rewriteSessionHistory(record, record.history, session.sessionHome);
  saveSession(record, session.sessionHome);
  const parts: string[] = [];
  if (wantCode) parts.push("code");
  if (wantConversation) parts.push("conversation");
  return {
    ok: true,
    message: `Rewound to turn ${target.index} ("${target.label.slice(0, 60)}") — restored ${parts.join(" + ")}.`,
  };
}

export function handleSessionCommand(session: SessionConfig, subcmd: string, restArgs: string): void {
  const op = subcmd.toLowerCase();
  if (!op || op === "list") {
    const list = listSessions(restArgs.includes("--all") ? undefined : session.repoRoot, session.sessionHome);
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
    const list = listSessions(session.repoRoot, session.sessionHome);
    const num = Number(target);
    let targetId = target;
    if (!isNaN(num) && num >= 1 && num <= list.length) {
      targetId = list[num - 1].id;
    }
    const loaded = loadSession(targetId, session.sessionHome);
    if (!loaded) {
      console.log(c.yellow(`Session not found: ${target}`));
      return;
    }
    // Save current session first if it has turns or history
    if (session.activeSession && (session.activeSession.turnCount > 0 || (session.history && session.history.length > 0))) {
      session.activeSession.history = session.history ?? [];
      saveSession(session.activeSession, session.sessionHome);
    }
    session.activeSession = loaded;
    session.history = loaded.history ?? [];
    // Restore the persisted checkpoint index (SS-1) so /undo and /rewind
    // survive restarts even though git refs were always persistent.
    if (session.checkpoints?.setCheckpoints && loaded.checkpoints) {
      session.checkpoints.setCheckpoints(loaded.checkpoints.map((c) => ({ ...c })));
    }
    if (loaded.model) session.model = loaded.model;
    if (loaded.provider) session.provider = loaded.provider;
    if (loaded.baseURL) session.baseURL = loaded.baseURL;
    console.log(`Resumed session ${c.cyan(loaded.id)}: "${c.bold(loaded.title)}" (${c.green(`${Math.floor(session.history.length / 2)} turn(s)`)} in context).`);
    return;
  }

  if (op === "new") {
    if (session.activeSession && (session.activeSession.turnCount > 0 || (session.history && session.history.length > 0))) {
      session.activeSession.history = session.history ?? [];
      saveSession(session.activeSession, session.sessionHome);
    }
    session.activeSession = createSession(session.repoRoot, {
      title: restArgs || "New session",
      model: session.model,
      provider: session.provider,
      baseURL: session.baseURL,
    });
    session.history = [];
    if (session.checkpoints?.setCheckpoints) session.checkpoints.setCheckpoints([]);
    saveSession(session.activeSession, session.sessionHome);
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
    saveSession(session.activeSession, session.sessionHome);
    console.log(`Saved session ${c.cyan(session.activeSession.id)}: "${c.bold(session.activeSession.title)}".`);
    return;
  }

  if (op === "delete" || op === "del" || op === "rm") {
    const target = restArgs.trim();
    if (!target) {
      console.log(c.dim("Usage: /session delete <number | session-id>"));
      return;
    }
    const list = listSessions(session.repoRoot, session.sessionHome);
    const num = Number(target);
    let targetId = target;
    if (!isNaN(num) && num >= 1 && num <= list.length) {
      targetId = list[num - 1].id;
    }
    const success = deleteSession(targetId, session.sessionHome);
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

export function printShortcuts(): void {
  console.log(`
  ${pc.bold(pc.white("Keyboard Shortcuts & Quick Actions:"))}
    ${pc.cyan("? / /help")}         Show all commands and shortcuts
    ${pc.cyan("+")}                 Fan out subagents to explore codebase
    ${pc.cyan("Ctrl+C / Esc")}      Interrupt running task
    ${pc.cyan("Ctrl+T")}            Toggle task list (expanded / compact)
    ${pc.cyan("Ctrl+O / /t")}       Toggle model thinking stream
    ${pc.cyan("Ctrl+End")}          Jump to bottom of terminal output
    ${pc.cyan("/undo")}             Revert file changes from last turn
    ${pc.cyan("/plan")}             Lock modifications for read-only exploration
    ${pc.cyan("/mode [auto|manual]")} Toggle auto-approval of terminal commands (/auto, /manual)
`);
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
  // Restore the persisted checkpoint index (SS-1) alongside history.
  if (session.activeSession?.checkpoints && session.checkpoints.setCheckpoints) {
    session.checkpoints.setCheckpoints(session.activeSession.checkpoints.map((c) => ({ ...c })));
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

  // Pad down to the bottom of the terminal window so the prompt box is fixed at the bottom rows
  const padToBottom = (linesUsed: number = 8) => {
    if (!process.stdout?.isTTY) return;
    const rows = process.stdout.rows || 24;
    const needed = Math.max(0, rows - linesUsed - 3);
    if (needed > 0) {
      process.stdout.write("\n".repeat(needed));
    }
  };

  const initialLinesUsed = 8 + startupNotices.length * 2;
  padToBottom(initialLinesUsed);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${pc.bold(pc.white(">"))} `,
    removeHistoryDuplicates: true,
  });
  loadHistory(rl);

  if (!session.permissions) {
    const settings = loadPermissionSettings(session.repoRoot);
    session.permissions = new PermissionManager({
      autoApprove: session.autoApprove ?? false,
      mode: session.autoApprove ? "bypass" : settings.mode,
      allow: settings.allow,
      deny: settings.deny,
      ask: settings.ask,
      handler: async (req) => {
        session.activeReporter?.suspend?.();
        rl.pause();
        try {
          const decision = await promptPermission(req.target, req.type === "edit" ? "Edit" : "Execute");
          if (decision === "always") {
            if (req.type === "edit") session.permissions?.allowRule(`Edit(${req.target})`);
            else session.permissions?.allowCommand(req.target);
            console.log(pc.dim(`  ${icons.check} Allowed this exact ${req.type} for the session: ${req.target}`));
            logAudit(session.repoRoot, { kind: "permission", tool: req.type, args: { target: req.target }, decision: "allow_session" });
            return true;
          }
          logAudit(session.repoRoot, {
            kind: "permission",
            tool: req.type,
            args: { target: req.target },
            decision: decision === "yes" ? "allow" : "deny",
          });
          return decision === "yes";
        } finally {
          rl.resume();
          session.activeReporter?.resume?.();
        }
      },
    });
  }

  // Plan-mode gate (AG-9): exit_plan_mode shows the plan and waits for
  // accept / edit / reject. A returned string is the user-revised plan.
  if (!session.planApprover) {
    session.planApprover = async (plan: string): Promise<boolean | string> => {
      session.activeReporter?.suspend?.();
      rl.pause();
      try {
        const decision = await promptPlanApproval(plan);
        if (decision === "accept") return true;
        if (decision === "reject") {
          console.log(pc.yellow("  Plan rejected — staying in plan mode."));
          return false;
        }
        rl.resume();
        const revised = await new Promise<string>((resolve) => {
          rl.question(pc.cyan("  Revised plan (Enter to keep as-is): "), (answer) => resolve(answer));
        });
        const text = revised.trim() || plan;
        console.log(pc.green("  Plan revised — unlocking with the edited plan."));
        return text;
      } finally {
        rl.resume();
        session.activeReporter?.resume?.();
      }
    };
  }

  let running = false;
  let controller = new AbortController();
  let sigintCount = 0;
  let thoughtExpanded = session.autoExpandThought ?? false;
  session.todosExpanded = session.todosExpanded ?? true;

  const onKeypress = (_str: string, key: readline.Key) => {
    if (key && key.name === "return" && !running) {
      clearBottomBox();
    }
    if (key && key.name === "escape") {
      if (running) {
        console.log(c.yellow("\nCancelling... (esc to interrupt)"));
        controller.abort();
        return;
      }
    }
    if (key && key.ctrl && key.name === "end") {
      process.stdout.write("\x1b[9999;1H");
      session.activeReporter?.onJumpToBottom?.();
      promptUser(true);
      return;
    }
    // Ctrl+T works mid-run as well: the reporter owns its sticky footer
    // lines and redraws them in place, so no console output is needed.
    if (key && key.ctrl && key.name === "t") {
      session.todosExpanded = !(session.todosExpanded ?? true);
      if (running) {
        session.activeReporter?.setTodosExpanded(session.todosExpanded);
        return;
      }
      readline.cursorTo(process.stdout, 0);
      readline.clearLine(process.stdout, 0);
      const stateStr = session.todosExpanded ? pc.green("expanded") : pc.dim("collapsed");
      console.log(`\n  ${pc.cyan("✻ Tasks view:")} ${stateStr} ${pc.dim("(Ctrl+T or /todos to toggle)")}`);
      if (session.todosExpanded && session.todoManager) {
        const list = session.todoManager.getTodos();
        if (list.length > 0) {
          console.log(`\n${renderTodoList(list)}`);
        }
      }
      promptUser(true);
      return;
    }
    if (running) return;
    if (key && key.ctrl && key.name === "o") {
      readline.cursorTo(process.stdout, 0);
      readline.clearLine(process.stdout, 0);
      if (latestThought?.text) {
        thoughtExpanded = !thoughtExpanded;
        console.log(`\n${formatThoughtLine(latestThought.durationMs, thoughtExpanded, latestThought.text)}\n`);
      } else {
        console.log(c.dim("\n  No thinking text recorded for the latest turn."));
      }
      promptUser(true);
    }
  };

  const onResize = () => {
    if (!running && process.stdout?.isTTY) {
      drawBottomBox();
    }
  };

  if (process.stdin.isTTY) {
    process.stdin.on("keypress", onKeypress);
  }
  if (process.stdout?.isTTY) {
    process.stdout.on("resize", onResize);
  }

  const drawBottomBox = () => {
    if (!process.stdout?.isTTY || running) return;
    const cols = process.stdout.columns || 80;
    const border = pc.dim("─".repeat(cols));
    const isPlan = session.planModeManager?.isActive();
    const isAuto = session.permissions?.isAutoApprove() ?? session.autoApprove ?? false;
    const dock = renderStatusDock({
      mode: isPlan ? "plan" : isAuto ? "auto" : "manual",
      isRunning: false,
    });
    const promptLen = (session.planModeManager?.isActive() ? "[PLAN] > " : "> ").length;
    const cursorCol = promptLen + (rl.cursor || 0);

    // From prompt row: move down 1 -> clear & draw border; move down 1 -> clear & draw dock; move up 2 -> restore cursor position
    process.stdout.write(`\n\x1b[2K${border}\n\x1b[2K  ${dock}\x1b[2A\r\x1b[${cursorCol + 1}G`);
  };

  const clearBottomBox = () => {
    if (!process.stdout?.isTTY) return;
    const promptLen = (session.planModeManager?.isActive() ? "[PLAN] > " : "> ").length;
    const cursorCol = promptLen + (rl.cursor || 0);
    process.stdout.write(`\n\x1b[2K\n\x1b[2K\x1b[2A\r\x1b[${cursorCol + 1}G`);
  };

  const promptUser = (preserve?: boolean) => {
    if (running) return;
    if (session.planModeManager?.isActive()) {
      rl.setPrompt(`${pc.bold(pc.cyan("[PLAN]"))} ${pc.bold(">")} `);
    } else {
      rl.setPrompt(`${pc.bold(pc.white(">"))} `);
    }
    rl.prompt(preserve);
    drawBottomBox();
  };

  // Hook _refreshLine so typing live keeps the bottom border and dock pinned below the cursor
  const origRefreshLine = (rl as any)._refreshLine?.bind(rl);
  if (origRefreshLine) {
    (rl as any)._refreshLine = function () {
      origRefreshLine();
      if (!running) {
        drawBottomBox();
      }
    };
  }

  // Manual SIGINT handling: cancel run first, exit only when idle.
  rl.on("SIGINT", () => {
    if (running) {
      console.log(c.yellow("\nCancelling... (finishing current tool call)"));
      controller.abort();
      return;
    }
    clearBottomBox();
    sigintCount++;
    if (sigintCount >= 2) {
      if (process.stdin.isTTY) {
        process.stdin.removeListener("keypress", onKeypress);
      }
      console.log(c.dim("\nBye."));
      rl.close();
    } else {
      console.log(c.dim("\n(To exit, press Ctrl+C again or type /exit)"));
      promptUser();
    }
  });

  promptUser();

  for await (let line of rl) {
    clearBottomBox();
    sigintCount = 0;
    let trimmed = line.trim();

    if (!trimmed) {
      promptUser();
      continue;
    }

    if (trimmed === "?" || trimmed === "/?") {
      printShortcuts();
      promptUser();
      continue;
    }

    if (trimmed === "+") {
      line = "fan out subagents to explore the codebase thoroughly";
      trimmed = line;
    }

    // `# note` appends to the project memory file (AG-8). Not a task.
    if (trimmed.startsWith("#")) {
      const note = trimmed.replace(/^#+\s*/, "");
      if (!note) {
        console.log(c.dim("Usage: # <note to remember in the project memory file>"));
      } else {
        try {
          const file = appendMemoryNote(session.repoRoot, note);
          console.log(pc.green(`  ✔ Remembered in ${file}`));
        } catch (error) {
          console.error(pc.red(`  Could not save note: ${error instanceof Error ? error.message : error}`));
        }
      }
      saveHistory(trimmed);
      promptUser();
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
        case "shortcuts":
          printShortcuts();
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
            const newRoot = path.resolve(args);
            if (newRoot === session.repoRoot) {
              console.log(c.dim(`  Already on repository: ${session.repoRoot}`));
              break;
            }
            session.repoRoot = newRoot;
            // Rebind repo-scoped state so /undo, /checkpoints and drift
            // detection never reference the previous repository.
            session.checkpoints = new CheckpointManager(newRoot);
            session.fileStateCache = new FileStateCache();
            session.isWorktree = false;
            session.mainRepoRoot = undefined;
            console.log(`Repository → ${c.cyan(newRoot)}`);
            printBanner(session);
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
        case "compact": {
          const focus = args.trim();
          if (session.history && session.history.length > 0) {
            const before = session.history.length;
            const modelSettings = loadModelSettings(session.repoRoot);
            let summarizer: Responder | undefined;
            if (modelSettings.fast) {
              try {
                summarizer = createProviderFromEnv(process.env, {
                  ...sessionOverrides(session),
                  model: modelSettings.fast,
                }).responder;
              } catch {
                summarizer = undefined;
              }
            }
            try {
              session.history = summarizer
                ? await compactHistoryWithSummary(session.history, summarizer, { keepRecentToolOutputs: 1, aggressive: true, focus: focus || undefined })
                : compactHistory(session.history, { keepRecentToolOutputs: 1, aggressive: true });
            } catch {
              session.history = compactHistory(session.history, { keepRecentToolOutputs: 1, aggressive: true });
            }
            if (focus) {
              session.history = [...session.history, { role: "user", content: `[Focus for compacted context: ${focus}]` }];
            }
            console.log(`Compacted context memory (${c.cyan(`${before} items`)} → ${c.green(`${session.history.length} items`)}).`);
          } else {
            console.log(c.dim("Context memory is already compact / empty."));
          }
          break;
        }
        case "cost":
          printCost(session);
          break;
        case "init": {
          const { file, created } = generateMemoryFile(session.repoRoot);
          console.log(
            created
              ? pc.green(`  ✔ Created project memory file: ${file}`)
              : c.dim(`  Memory file already exists: ${file} (edit it directly, or add notes with #)`),
          );
          break;
        }
        case "sessions": {
          handleSessionCommand(session, "list", args);
          if (process.stdin.isTTY) {
            const list = listSessions(args.includes("--all") ? undefined : session.repoRoot, session.sessionHome);
            if (list.length > 0) {
              rl.pause();
              try {
                const chosen = await promptSessionSelect(list, session.activeSession?.id);
                if (chosen) {
                  handleSessionCommand(session, "resume", chosen);
                }
              } finally {
                rl.resume();
              }
            }
          }
          break;
        }
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
            // Keep the persisted index in sync (SS-1).
            if (session.activeSession) {
              session.activeSession.checkpoints = session.checkpoints
                .listCheckpoints()
                .map((c) => ({ ...c }));
              saveSession(session.activeSession, session.sessionHome);
            }
            console.log(pc.green(`  ✔ Reverted workspace to checkpoint: "${restored.label}" (${restored.id})`));
            const status = await gitStatus(session.repoRoot);
            if (status && status !== "(clean)") {
              console.log(c.dim("  git status:\n") + status.split("\n").map((l) => "    " + l).join("\n"));
            } else {
              console.log(c.dim("  Working tree is clean."));
            }
            console.log(c.dim("  Tip: /rewind restores code + conversation to an earlier turn; /undo restores code only."));
          } else {
            console.log(c.yellow("  No checkpoints available to undo."));
          }
          break;
        }
        case "rewind": {
          const tokens = args.trim().split(/\s+/).filter(Boolean);
          let selector = "";
          let scope: RewindScope = "both";
          for (const t of tokens) {
            const low = t.toLowerCase();
            if (low === "code" || low === "conversation" || low === "both") scope = low as RewindScope;
            else if (!selector) selector = t;
          }
          if (!selector) {
            const turns = session.activeSession?.turns ?? [];
            if (turns.length === 0) {
              console.log(c.yellow("  No turns recorded yet — nothing to rewind."));
              break;
            }
            console.log(pc.bold("\nTurns in this session:"));
            turns.forEach((t) => {
              console.log(`  ${t.index}. "${t.label.slice(0, 60)}" (${new Date(t.timestamp).toLocaleTimeString()})${t.checkpointId ? c.dim(` [${t.checkpointId}]`) : ""}`);
            });
            if (!process.stdin.isTTY) {
              console.log(c.dim("\n  Usage: /rewind <turn-number> [code|conversation|both]\n"));
              break;
            }
            rl.pause();
            try {
              const picked = await promptRewindSelect(turns);
              if (picked == null) break;
              selector = String(picked);
            } finally {
              rl.resume();
            }
          }
          const result = await doRewind(session, selector, scope);
          console.log(result.ok ? pc.green(`  ✔ ${result.message}`) : c.yellow(`  ${result.message}`));
          break;
        }
        case "export": {
          if (!session.activeSession) {
            console.log(c.yellow("  No active session to export."));
            break;
          }
          const target = args.trim() || path.join(session.repoRoot, defaultExportFilename(session.activeSession));
          const file = path.isAbsolute(target) ? target : path.join(session.repoRoot, target);
          try {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, exportSessionMarkdown(session.activeSession), "utf8");
            console.log(pc.green(`  ✔ Exported session to ${file}`));
          } catch (error) {
            console.error(pc.red(`  Could not export: ${error instanceof Error ? error.message : error}`));
          }
          break;
        }
        case "checkpoints": {
          const list = session.checkpoints?.listCheckpoints() ?? [];
          const turns = session.activeSession?.turns ?? [];
          if (list.length === 0 && turns.length === 0) {
            console.log(c.dim("  No checkpoints saved yet in this session."));
          } else {
            if (list.length > 0) {
              console.log(pc.bold("\nSession Checkpoints:"));
              list.forEach((cp, idx) => {
                console.log(`  ${idx + 1}. ${c.cyan(cp.id)}: "${cp.label}" (${new Date(cp.timestamp).toLocaleTimeString()})`);
              });
            }
            if (turns.length > 0) {
              console.log(pc.bold("\nTurns (for /rewind <n> [code|conversation|both]):"));
              turns.forEach((t) => {
                console.log(`  ${t.index}. "${t.label.slice(0, 60)}"${t.checkpointId ? c.dim(` [${t.checkpointId}]`) : ""}`);
              });
            }
            console.log(c.dim("\n  Type /undo to revert code to the most recent checkpoint, or /rewind <n> to restore an earlier turn.\n"));
          }
          break;
        }
        case "plan": {
          if (!session.planModeManager) session.planModeManager = new PlanModeManager();
          const arg = args.trim().toLowerCase();
          if (arg === "off" || (session.planModeManager.isActive() && arg !== "on")) {
            session.planModeManager.exit(args || "Manually exited plan mode via CLI");
            console.log(pc.green("\n  ✔ Exited Plan Mode. Ready for execution.\n"));
          } else {
            session.planModeManager.enter();
            console.log(pc.cyan("\n  ✻ Entered Plan Mode. Code modifications are locked; inspection tools enabled.\n"));
          }
          break;
        }
        case "auto": {
          session.autoApprove = true;
          session.permissions?.setAutoApprove(true);
          session.activeReporter?.setIsAutoMode?.(true);
          console.log(pc.green("\n  ● Switched to Auto Mode. Shell commands will run without confirmation prompts.\n"));
          break;
        }
        case "manual": {
          session.autoApprove = false;
          session.permissions?.setAutoApprove(false);
          session.activeReporter?.setIsAutoMode?.(false);
          console.log(pc.cyan("\n  • Switched to Manual Mode. Shell commands will prompt for confirmation.\n"));
          break;
        }
        case "mode": {
          const targetMode = args.trim().toLowerCase();
          if (targetMode === "auto") {
            session.autoApprove = true;
            session.permissions?.setAutoApprove(true);
            session.activeReporter?.setIsAutoMode?.(true);
            console.log(pc.green("\n  ● Switched to Auto Mode. Shell commands will run without confirmation prompts.\n"));
          } else if (targetMode === "manual") {
            session.autoApprove = false;
            session.permissions?.setAutoApprove(false);
            session.activeReporter?.setIsAutoMode?.(false);
            console.log(pc.cyan("\n  • Switched to Manual Mode. Shell commands will prompt for confirmation.\n"));
          } else {
            const current = session.permissions?.isAutoApprove() ? "auto" : "manual";
            console.log(c.dim(`\n  Current execution mode: ${c.bold(current)} (options: /mode auto | /mode manual, or /auto, /manual)\n`));
          }
          break;
        }
        case "todos":
        case "tasks":
        case "todo": {
          const arg = args.trim().toLowerCase();
          if (arg === "clear") {
            session.todoManager?.clear();
            console.log(pc.green("\n  ✔ Cleared todo list.\n"));
          } else if (arg === "toggle") {
            session.todosExpanded = !(session.todosExpanded ?? true);
            console.log(`\n  Tasks view: ${session.todosExpanded ? pc.green("expanded") : pc.dim("collapsed")}\n`);
          } else {
            const list = session.todoManager?.getTodos() ?? [];
            if (list.length === 0) {
              console.log(c.dim("\n  No active tasks in todo list. The agent will create one on multi-step tasks.\n"));
            } else {
              console.log(`\n${renderTodoList(list)}\n`);
            }
          }
          break;
        }
        case "worktree": {
          const parts = args.trim().split(/\s+/);
          const sub = parts[0]?.toLowerCase() || "status";
          const target = parts.slice(1).join(" ").trim();

          if (sub === "create" || sub === "new") {
            const slug = target || "task";
            try {
              console.log(c.dim(`  Creating isolated worktree for '${slug}'...`));
              const info = await createWorktree(session.repoRoot, slug);
              session.mainRepoRoot = session.mainRepoRoot ?? session.repoRoot;
              session.repoRoot = info.worktreePath;
              session.isWorktree = true;
              console.log(pc.green(`  ✔ Created and switched to worktree:`));
              console.log(`    ${pc.bold("Path:")}   ${info.worktreePath}`);
              console.log(`    ${pc.bold("Branch:")} ${info.branch}`);
              console.log(c.dim(`    All agent operations are now isolated in this worktree.\n`));
            } catch (err) {
              console.error(pc.red(`  Failed to create worktree: ${err instanceof Error ? err.message : err}`));
            }
          } else if (sub === "main" || sub === "root" || sub === "leave") {
            if (!session.isWorktree) {
              console.log(c.dim("  Already on primary workspace repository."));
            } else {
              const mainRoot = session.mainRepoRoot ?? resolveMainRootFromWorktree(session.repoRoot);
              session.repoRoot = mainRoot;
              session.mainRepoRoot = undefined;
              session.isWorktree = false;
              console.log(pc.green(`  ✔ Returned to main repository: ${mainRoot}`));
            }
          } else if (sub === "status") {
            console.log(`  ${pc.bold("Current Workspace:")} ${session.repoRoot}${session.isWorktree ? pc.yellow(" (isolated worktree)") : " (main repo)"}`);
            if (session.isWorktree) {
              const modified = await hasWorktreeModifications(session.repoRoot);
              console.log(`  ${pc.bold("Has Modifications:")} ${modified ? pc.yellow("Yes") : pc.green("Clean")}`);
            }
          } else {
            console.log(c.dim("  Usage: /worktree create <slug> | /worktree main | /worktree status"));
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
            saveSession(session.activeSession, session.sessionHome);
          }
          if (session.checkpoints?.setCheckpoints) session.checkpoints.setCheckpoints([]);
          printBanner(session);
          padToBottom(8);
          break;
        case "exit":
        case "quit":
          clearBottomBox();
          console.log(c.dim("Bye."));
          if (process.stdin.isTTY) {
            process.stdin.removeListener("keypress", onKeypress);
          }
          if (process.stdout?.isTTY) {
            process.stdout.removeListener("resize", onResize);
          }
          rl.close();
          return;
        default:
          console.log(c.yellow(`Unknown command /${cmd}. Try /help.`));
          break;
      }
      promptUser();
      continue;
    }

    // Plain text = a task. Take a per-turn checkpoint (SS-1) so /undo and
    // /rewind can restore code; the turn (history delta) is appended in runTask.
    const historyStart = session.history?.length ?? 0;
    let turnCheckpoint: { id: string; hash: string } | undefined;
    if (session.checkpoints) {
      const cp = await session.checkpoints.saveCheckpoint(trimmed);
      if (cp && session.activeSession) {
        turnCheckpoint = { id: cp.id, hash: cp.commitHash };
        // Persist the checkpoint index with the session (SS-1).
        if (!session.activeSession.checkpoints?.some((c) => c.id === cp.id)) {
          session.activeSession.checkpoints = [
            ...(session.activeSession.checkpoints ?? []),
            { id: cp.id, timestamp: cp.timestamp, label: cp.label, commitHash: cp.commitHash },
          ];
          saveSession(session.activeSession, session.sessionHome);
        }
        if (session.checkpoints.setCheckpoints) {
          session.checkpoints.setCheckpoints(
            (session.activeSession.checkpoints ?? []).map((c) => ({ ...c })),
          );
        }
      }
    }

    running = true;
    controller = new AbortController();
    // Show a styled user message block before the agent responds so it's
    // visually clear which text is the user query vs agent output.
    printUserMessage(trimmed, { prompt: rl.getPrompt(), input: line });
    try {
      await runTask(session, trimmed, controller.signal, {
        historyStart,
        checkpointId: turnCheckpoint?.id,
        checkpointHash: turnCheckpoint?.hash,
      });
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
    promptUser();
  }
}
