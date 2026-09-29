import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import boxen from "boxen";
import { getSandboxMode } from "../../tools/sandbox.js";
import { icons, pc } from "./theme.js";

export interface BannerInfo {
  repoRoot: string;
  model: string;
  providerKind?: string;
  baseURL?: string;
  sessionId?: string;
  sessionTitle?: string;
  turnCount?: number;
  needsKey?: boolean;
}

export function readPackageVersion(): string {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkgPath = path.resolve(here, "..", "..", "..", "package.json");
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { version?: string };
      return pkg.version ?? "0.1.0";
    }
  } catch {
    // fallback
  }
  return "0.1.0";
}

export function getGitBranch(cwd: string): string | null {
  try {
    const branch = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    }).trim();
    return branch || null;
  } catch {
    return null;
  }
}

const WELCOME_TIPS: string[] = [
  "Ask for a plan first — /plan locks read-only exploration before large refactors",
  "Press Ctrl+T to toggle the live task list, Ctrl+O to expand thinking",
  "/undo instantly reverts every file change made in the last task",
  "Use /worktree create <slug> to run risky changes in an isolated git worktree",
  "Switch models mid-session with /model <id> — keys are never stored in history",
  "/compact trims context memory when a session grows long",
  "Run /sessions to jump back into a previous conversation",
  "/sandbox docker isolates every terminal command in a container",
  "Ask questions in plain language — the agent plans, edits, and verifies",
];

/** Deterministic-random selection of welcome tips (rotates each launch). */
export function pickWelcomeTips(pool: string[] = WELCOME_TIPS, count = 3): string[] {
  const arr = [...pool];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.slice(0, count);
}

export function renderBanner(info: BannerInfo): void {
  const version = readPackageVersion();
  const branch = getGitBranch(info.repoRoot);
  const branchBadge = branch ? pc.dim(` (${icons.branch} ${branch})`) : "";

  const terracotta = (s: string) => `\x1b[38;2;227;100;70m${s}\x1b[0m`;

  // 5-line pixel art mascot matching Claude Code's terracotta mascot
  const mascotLines = [
    terracotta("  ▄   ▄  "),
    terracotta(" █▀█▀█▀█ "),
    terracotta(" █ ▀ ▀ █ "),
    terracotta(" █▄▄▄▄▄█ "),
    terracotta("  █ █ █  "),
  ];

  const statusText = info.needsKey
    ? pc.yellow("Needs API Key (/key)")
    : pc.dim("API Usage Ready");

  const modelLine = `${pc.dim(info.model)} · ${statusText}`;
  const titleLine = `${pc.bold(pc.white("CodeAgent"))} ${pc.bold(pc.white(`v${version}`))}`;
  const pathLine = pc.dim(`${info.repoRoot}${branchBadge}`);

  const infoLines = [
    titleLine,
    modelLine,
    pathLine,
    "",
    "",
  ];

  if (info.needsKey) {
    infoLines[3] = pc.yellow("Run /key <api-key> to set your LLM key (Groq / OpenAI / OpenRouter).");
  }

  console.log("");
  for (let i = 0; i < mascotLines.length; i++) {
    const mascot = mascotLines[i];
    const text = infoLines[i] || "";
    console.log(` ${mascot}  ${text}`);
  }
  console.log("");
}
