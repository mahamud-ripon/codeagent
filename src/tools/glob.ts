import fs from "node:fs/promises";
import path from "node:path";
import { isIgnoredDir } from "../repo/ignore.js";
import { truncate, TRUNCATION_BUDGETS } from "../utils/truncate.js";

function matchGlob(relative: string, pattern: string): boolean {
  const normalized = relative.replace(/\\/g, "/");
  const source = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, ".*");
  return new RegExp(`^${source}$`, "i").test(normalized) || new RegExp(source, "i").test(normalized);
}

/** List repo files matching a glob. Ignores dependency and build directories. */
export async function globFiles(repoRoot: string, pattern: string): Promise<string> {
  const query = pattern.trim();
  if (!query) throw new Error("glob pattern cannot be empty");
  const root = path.resolve(repoRoot);
  const matches: string[] = [];

  async function walk(dir: string): Promise<void> {
    if (matches.length >= 2000) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (isIgnoredDir(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        const rel = path.relative(root, full).split(path.sep).join("/");
        if (matchGlob(rel, query)) matches.push(rel);
      }
      if (matches.length >= 2000) return;
    }
  }

  await walk(root);
  if (matches.length === 0) return "No files matched.";
  return truncate(matches.sort().join("\n"), TRUNCATION_BUDGETS.listFiles);
}
