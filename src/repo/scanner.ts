import fs from "node:fs/promises";
import path from "node:path";
import { isIgnoredDir } from "./ignore.js";
import { truncate } from "../utils/truncate.js";

export interface RepoMap {
  /** Newline-separated repo-relative file list (truncated). */
  files: string;
  totalFiles: number;
  truncated: boolean;
  /** Parsed package.json scripts, when present. */
  scripts: Record<string, string>;
  /** Short human-readable summary injected into the agent context. */
  summary: string;
}

const MAX_FILES = 2000;
const MAX_SUMMARY_CHARS = 2500;
const MAX_SUMMARY_FILES = 120;

async function readPackageScripts(repoRoot: string): Promise<Record<string, string>> {
  try {
    const raw = await fs.readFile(path.join(repoRoot, "package.json"), "utf8");
    const parsed = JSON.parse(raw) as { scripts?: Record<string, string> };
    if (parsed.scripts && typeof parsed.scripts === "object") {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed.scripts)) {
        if (typeof v === "string") out[k] = v;
      }
      return out;
    }
  } catch {
    // Not a Node repo or unreadable package.json — not fatal.
  }
  return {};
}

async function collectFiles(repoRoot: string): Promise<{ files: string[]; hitLimit: boolean }> {
  const root = path.resolve(repoRoot);
  const results: string[] = [];
  let hitLimit = false;

  async function walk(dir: string): Promise<void> {
    if (results.length >= MAX_FILES) {
      hitLimit = true;
      return;
    }
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (isIgnoredDir(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        results.push(path.relative(root, full).split(path.sep).join("/"));
        if (results.length >= MAX_FILES) {
          hitLimit = true;
          return;
        }
      }
      if (hitLimit) return;
    }
  }

  await walk(root);
  return { files: results, hitLimit };
}

/**
 * Build a cheap repository map: file list + package.json scripts.
 * This is injected once at the start of the run so the model does not
 * have to discover the repo layout through dozens of list_files calls.
 */
export async function buildRepoMap(repoRoot: string): Promise<RepoMap> {
  const [{ files, hitLimit }, scripts] = await Promise.all([
    collectFiles(repoRoot),
    readPackageScripts(repoRoot),
  ]);

  const filesText = files.join("\n");
  const shown = files.slice(0, MAX_SUMMARY_FILES).join("\n");
  const hidden = files.length - Math.min(files.length, MAX_SUMMARY_FILES);
  const scriptLines = Object.entries(scripts).map(([k, v]) => `  ${k} -> ${v}`);
  const summary = [
    `Repository root: ${path.resolve(repoRoot)}`,
    `Files (${files.length}${hitLimit ? "+" : ""}):`,
    truncate(shown, MAX_SUMMARY_CHARS) || "(empty repository)",
    ...(hidden > 0 ? [`... and ${hidden} more files (use list_files / search to explore)`] : []),
    scriptLines.length > 0
      ? `Available npm scripts:\n${scriptLines.join("\n")}`
      : "No package.json scripts found.",
  ].join("\n");

  return {
    files: filesText,
    totalFiles: files.length,
    truncated: hitLimit,
    scripts,
    summary,
  };
}
