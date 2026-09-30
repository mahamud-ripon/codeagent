import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

/**
 * EX-2: custom slash commands from .codeagent/commands/*.md (project) and
 * ~/.codeagent/commands/*.md (global), with $ARGUMENTS, @file, !cmd, frontmatter.
 */

export interface CustomCommand {
  name: string;
  description: string;
  prompt: string;
  source: string;
}

function parseCommandFile(raw: string, fallbackName: string): CustomCommand {
  let description = "";
  let body = raw;
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (m) {
    body = m[2] ?? "";
    const desc = m[1]!.match(/description\s*:\s*(.+)/)?.[1]?.trim();
    if (desc) description = desc.replace(/^["']|["']$/g, "");
  }
  if (!description) description = body.split("\n")[0]?.slice(0, 120) ?? fallbackName;
  return { name: fallbackName, description, prompt: body.trim(), source: fallbackName };
}

export async function loadCustomCommands(repoRoot: string, homeDir: string = os.homedir()): Promise<CustomCommand[]> {
  const dirs = [
    path.join(homeDir, ".codeagent", "commands"),
    path.join(repoRoot, ".codeagent", "commands"),
  ];
  const out: CustomCommand[] = [];
  const seen = new Set<string>();
  for (const dir of dirs) {
    let files: string[] = [];
    try {
      files = (await fs.readdir(dir)).filter((f) => f.endsWith(".md"));
    } catch {
      continue;
    }
    for (const file of files) {
      const name = path.basename(file, ".md");
      if (seen.has(name)) continue;
      seen.add(name);
      try {
        const raw = await fs.readFile(path.join(dir, file), "utf8");
        out.push({ ...parseCommandFile(raw, name), source: path.join(dir, file) });
      } catch {
        // skip
      }
    }
  }
  return out;
}

/** Expand $ARGUMENTS, @file mentions, and !shell snippets. Pure except !cmd. */
export async function expandCustomCommand(repoRoot: string, prompt: string, args: string): Promise<string> {
  let out = prompt.replace(/\$ARGUMENTS/g, args);
  // @file inclusion (repo-relative).
  const atFiles = [...out.matchAll(/@([^\s"'`]+)/g)].map((m) => m[1]!).filter(Boolean);
  for (const rel of atFiles.slice(0, 5)) {
    try {
      const content = await fs.readFile(path.join(repoRoot, rel), "utf8");
      out = out.replaceAll(`@${rel}`, `<file path="${rel}">\n${content.slice(0, 8000)}\n</file>`);
    } catch {
      // leave the mention as-is
    }
  }
  // !cmd execution (first 3 only, 10s timeout each).
  const cmds = [...out.matchAll(/!([^\n]+)/g)].map((m) => m[1]!.trim()).filter(Boolean).slice(0, 3);
  for (const cmd of cmds) {
    try {
      const { stdout } = await execAsync(cmd, { cwd: repoRoot, timeout: 10_000, maxBuffer: 256 * 1024 });
      out = out.replaceAll(`!${cmd}`, stdout.slice(0, 4000));
    } catch {
      out = out.replaceAll(`!${cmd}`, `[command failed: ${cmd}]`);
    }
  }
  return out;
}
