import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { TRUNCATION_BUDGETS, truncate } from "../utils/truncate.js";

const execFileAsync = promisify(execFile);

async function git(repoRoot: string, args: string[]): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd: repoRoot,
      maxBuffer: 2 * 1024 * 1024,
      timeout: 30_000,
    });
    return `${stdout}${stderr}`.trim() || "(clean)";
  } catch (error: unknown) {
    const err = error as { stdout?: string; stderr?: string; message?: string };
    const partial = `${err.stdout ?? ""}${err.stderr ?? ""}`.trim();
    // git diff exits 0 normally; status output may come with stderr — prefer partial output.
    if (partial) return truncate(partial, TRUNCATION_BUDGETS.gitStatus);
    throw new Error(`git ${args[0]} failed: ${err.message ?? String(error)}`);
  }
}

export async function gitStatus(repoRoot: string): Promise<string> {
  const out = await git(repoRoot, ["status", "--short"]);
  return truncate(out, TRUNCATION_BUDGETS.gitStatus);
}

export async function gitDiff(repoRoot: string): Promise<string> {
  const out = await git(repoRoot, ["diff", "--no-ext-diff"]);
  return truncate(out || "(no changes)", TRUNCATION_BUDGETS.gitDiff);
}
