import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { TRUNCATION_BUDGETS, truncate } from "../utils/truncate.js";
import { ripgrepIgnoreGlobs } from "../repo/ignore.js";

const execFileAsync = promisify(execFile);

let cachedRg: string | null = null;

/**
 * Resolve the rg binary: explicit RG_PATH env -> rg on PATH ->
 * bundled @vscode/ripgrep binary. Throws a helpful error if none found.
 */
export function resolveRgBinary(): string {
  if (cachedRg) return cachedRg;
  if (process.env.RG_PATH) {
    cachedRg = process.env.RG_PATH;
    return cachedRg;
  }
  try {
    const require = createRequire(import.meta.url);
    const mod = require("@vscode/ripgrep") as { rgPath?: string };
    if (mod.rgPath) {
      cachedRg = mod.rgPath;
      return cachedRg;
    }
  } catch {
    // fall through to PATH lookup
  }
  cachedRg = "rg";
  return cachedRg;
}

export async function search(repoRoot: string, query: string): Promise<string> {
  if (!query || !query.trim()) {
    throw new Error("Search query cannot be empty");
  }
  if (query.length > 500) {
    throw new Error("Search query too long (500 char limit)");
  }

  const rg = resolveRgBinary();
  const args = ["--line-number", "--no-heading", "--hidden"];
  for (const glob of ripgrepIgnoreGlobs()) {
    args.push("--glob", glob);
  }
  args.push("--", query, ".");

  try {
    const { stdout } = await execFileAsync(rg, args, {
      cwd: repoRoot,
      maxBuffer: 2 * 1024 * 1024,
      timeout: 30_000,
    });
    const out = stdout.trim();
    if (!out) return "No matches found.";
    return truncate(out, TRUNCATION_BUDGETS.search);
  } catch (error: unknown) {
    const err = error as { code?: number | string | null; stdout?: string; message?: string };
    // rg exits 1 when there are zero matches — that is a success for us.
    if (err.code === 1) return "No matches found.";
    if (err.code === "ENOENT" || /not recognized|not found/i.test(String(err.message))) {
      throw new Error(
        "ripgrep (rg) binary not found. Install ripgrep or set RG_PATH to an rg executable.",
      );
    }
    const partial = typeof err.stdout === "string" && err.stdout.trim()
      ? truncate(err.stdout.trim(), TRUNCATION_BUDGETS.search)
      : null;
    if (partial) return partial;
    throw new Error(`Search failed: ${err.message ?? String(error)}`);
  }
}
