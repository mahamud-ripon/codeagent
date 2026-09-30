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

export interface GrepOptions {
  query: string;
  path?: string;
  glob?: string;
  caseSensitive?: boolean;
  before?: number;
  after?: number;
  context?: number;
  outputMode?: "content" | "files" | "count";
}

/** ripgrep with path, glob, case, context, and output mode. */
export async function grep(repoRoot: string, options: GrepOptions): Promise<string> {
  const query = options.query?.trim() ?? "";
  if (!query) throw new Error("grep query cannot be empty");
  if (query.length > 500) throw new Error("grep query too long (500 char limit)");

  const rg = resolveRgBinary();
  const args = ["--line-number", "--hidden"];
  const mode = options.outputMode ?? "content";
  if (mode === "files") args.push("--files-with-matches");
  else if (mode === "count") args.push("--count");
  else args.push("--no-heading");
  if (options.caseSensitive === false) args.push("-i");
  if (options.context && options.context > 0) args.push("-C", String(Math.min(options.context, 20)));
  else {
    if (options.before && options.before > 0) args.push("-B", String(Math.min(options.before, 20)));
    if (options.after && options.after > 0) args.push("-A", String(Math.min(options.after, 20)));
  }
  if (options.glob) args.push("--glob", options.glob);
  for (const glob of ripgrepIgnoreGlobs()) args.push("--glob", glob);
  args.push("--", query, options.path && options.path.trim() ? options.path : ".");

  try {
    const { stdout } = await execFileAsync(rg, args, {
      cwd: repoRoot,
      maxBuffer: 2 * 1024 * 1024,
      timeout: 30_000,
    });
    const out = stdout.trim();
    if (!out) return mode === "count" ? "0" : "No matches found.";
    return truncate(out, TRUNCATION_BUDGETS.search);
  } catch (error: unknown) {
    const err = error as { code?: number | string | null; stdout?: string; message?: string };
    if (err.code === 1) return mode === "count" ? "0" : "No matches found.";
    if (err.code === "ENOENT" || /not recognized|not found/i.test(String(err.message))) {
      throw new Error("ripgrep (rg) binary not found. Install ripgrep or set RG_PATH to an rg executable.");
    }
    const partial = typeof err.stdout === "string" && err.stdout.trim() ? truncate(err.stdout.trim(), TRUNCATION_BUDGETS.search) : null;
    if (partial) return partial;
    throw new Error(`grep failed: ${err.message ?? String(error)}`);
  }
}
