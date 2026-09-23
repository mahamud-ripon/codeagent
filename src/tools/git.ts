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

export async function isGitRepo(repoRoot: string): Promise<boolean> {
  try {
    const out = await git(repoRoot, ["rev-parse", "--is-inside-work-tree"]);
    return out.trim() === "true";
  } catch {
    return false;
  }
}

/**
 * Creates an ephemeral shadow commit snapshot under refs/codeagent/checkpoints/<id>
 * without moving HEAD or modifying the current branch or git log.
 */
export async function createShadowCheckpoint(
  repoRoot: string,
  id: string,
  label = "checkpoint",
): Promise<string | null> {
  if (!(await isGitRepo(repoRoot))) return null;
  try {
    // Stage all files temporarily to snapshot exact state
    await git(repoRoot, ["add", "-A"]);
    const tree = (await git(repoRoot, ["write-tree"])).trim();

    let commitHash: string;
    try {
      const head = (await git(repoRoot, ["rev-parse", "HEAD"])).trim();
      commitHash = (await git(repoRoot, ["commit-tree", tree, "-p", head, "-m", label])).trim();
    } catch {
      // Empty / initial repository with no commits yet
      commitHash = (await git(repoRoot, ["commit-tree", tree, "-m", label])).trim();
    }

    await git(repoRoot, ["update-ref", `refs/codeagent/checkpoints/${id}`, commitHash]);
    // Reset index back to unstaged so user's workspace isn't staged
    await git(repoRoot, ["reset"]);
    return commitHash;
  } catch (error) {
    // If checkpoint fails (e.g. index locked), fail gracefully without stopping the agent
    return null;
  }
}

/**
 * Restores the workspace to the exact state saved in refs/codeagent/checkpoints/<id>.
 */
export async function restoreShadowCheckpoint(
  repoRoot: string,
  id: string,
): Promise<boolean> {
  if (!(await isGitRepo(repoRoot))) return false;
  try {
    const ref = `refs/codeagent/checkpoints/${id}`;
    // Verify ref exists
    await git(repoRoot, ["rev-parse", "--verify", ref]);
    // Checkout all files from checkpoint
    await git(repoRoot, ["checkout", ref, "--", "."]);
    // Remove newly created untracked files
    await git(repoRoot, ["clean", "-fd"]);
    // Unstage index
    await git(repoRoot, ["reset"]);
    return true;
  } catch {
    return false;
  }
}

