import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import boxen from "boxen";
import { colors, icons, pc } from "./theme.js";

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

export function renderBanner(info: BannerInfo): void {
  const version = readPackageVersion();
  const branch = getGitBranch(info.repoRoot);
  const branchBadge = branch ? pc.dim(` (${icons.branch} ${branch})`) : "";

  const titleLine = `${pc.bold(pc.cyan("▲ CODEAGENT"))} ${pc.dim(`v${version}`)}   ${info.needsKey ? pc.yellow(`${icons.warn} Needs API Key`) : pc.green(`${icons.connected} Ready`)}`;

  const lines: string[] = [
    titleLine,
    "",
    `  ${pc.bold("Workspace:")}  ${pc.white(info.repoRoot)}${branchBadge}`,
    `  ${pc.bold("Model:")}      ${pc.yellow(info.model)}${info.baseURL ? pc.dim(` (${info.baseURL})`) : ""}`,
  ];

  if (info.sessionId) {
    const turns = info.turnCount !== undefined ? ` · ${info.turnCount} turn(s)` : "";
    const title = info.sessionTitle ? ` ("${info.sessionTitle}")` : "";
    lines.push(`  ${pc.bold("Session:")}    ${pc.cyan(info.sessionId)}${pc.dim(`${title}${turns}`)}`);
  }

  if (info.needsKey) {
    lines.push("");
    lines.push(`  ${pc.yellow("Run /key <api-key> to set your LLM key (Groq / OpenAI / OpenRouter).")}`);
  }

  lines.push("");
  lines.push(`  ${pc.dim(`Type your task, or "${pc.cyan("/help")}" for commands · ${pc.cyan("Ctrl+C")} cancels`)}`);

  const box = boxen(lines.join("\n"), {
    padding: { top: 0, bottom: 0, left: 1, right: 1 },
    margin: { top: 1, bottom: 0 },
    borderColor: "cyan",
    borderStyle: "round",
  });

  console.log(box);
  console.log("");
}
