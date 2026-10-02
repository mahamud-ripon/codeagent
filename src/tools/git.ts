import { safeGitArgs } from "../utils/safeGit.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { TRUNCATION_BUDGETS, truncate } from "../utils/truncate.js";

const execFileAsync = promisify(execFile);

async function git(repoRoot: string, args: string[]): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync(
      "git",
      await safeGitArgs(repoRoot, args),
      {
        cwd: repoRoot,
        maxBuffer: 2 * 1024 * 1024,
        timeout: 30_000,
      },
    );
    return `${stdout}${stderr}`.trim() || "(clean)";
  } catch (error: unknown) {
    const err = error as { stdout?: string; stderr?: string; message?: string };
    const partial = `${err.stdout ?? ""}${err.stderr ?? ""}`.trim();
    // git diff exits 0 normally; status output may come with stderr — prefer partial output.
    if (partial) return truncate(partial, TRUNCATION_BUDGETS.gitStatus);
    throw new Error(`git ${args[0]} failed: ${err.message ?? String(error)}`);
  }
}

const gitRepoCache = new Map<string, boolean>();

export async function isGitRepo(repoRoot: string): Promise<boolean> {
  if (gitRepoCache.has(repoRoot)) return gitRepoCache.get(repoRoot)!;
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["rev-parse", "--is-inside-work-tree"],
      {
        cwd: repoRoot,
        timeout: 5000,
      },
    );
    const inside = stdout.trim() === "true";
    gitRepoCache.set(repoRoot, inside);
    return inside;
  } catch {
    gitRepoCache.set(repoRoot, false);
    return false;
  }
}

export function clearGitRepoCache(repoRoot?: string): void {
  if (repoRoot) gitRepoCache.delete(repoRoot);
  else gitRepoCache.clear();
}

export async function gitStatus(repoRoot: string): Promise<string> {
  if (!(await isGitRepo(repoRoot))) {
    return "(not a git repository — git tools are unavailable in this environment; verify files directly with read or list_files)";
  }
  const out = await git(repoRoot, ["status", "--short"]);
  return truncate(out, TRUNCATION_BUDGETS.gitStatus);
}

export async function gitDiff(
  repoRoot: string,
  readAllowed?: (file: string) => boolean,
): Promise<string> {
  if (!(await isGitRepo(repoRoot))) {
    return "(not a git repository — git diff unavailable in this environment; verify files directly with read or list_files)";
  }
  const paths = readAllowed
    ? (await git(repoRoot, ["diff", "--name-only", "--no-renames", "-z"]))
        .split("\0")
        .filter((p) => p && readAllowed(p))
    : undefined;
  if (paths && !paths.length) return "(no permitted changes)";
  const out = await git(repoRoot, [
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--no-renames",
    ...(paths ? ["--", ...paths] : []),
  ]);
  return truncate(out || "(no changes)", TRUNCATION_BUDGETS.gitDiff);
}

export async function gitLog(repoRoot: string, limit = 20): Promise<string> {
  if (!(await isGitRepo(repoRoot))) {
    return "(not a git repository — git log unavailable in this environment)";
  }
  const n = Math.min(Math.max(Math.floor(limit) || 20, 1), 100);
  const out = await git(repoRoot, ["log", "--oneline", "-n", String(n)]);
  return truncate(out, TRUNCATION_BUDGETS.gitStatus);
}

/**
 * Creates an ephemeral shadow commit snapshot under refs/codeagent/checkpoints/<id>
 * without moving HEAD or modifying the current branch or git log.
 *
 * Index-safe: prefers `git stash create -u` (no index mutation). Falls back
 * to the legacy add/write-tree path with a guaranteed reset in `finally`
 * so a crash between add and reset can't leave the workspace staged.
 */
export async function createShadowCheckpoint(
  repoRoot: string,
  id: string,
  label = "checkpoint",
): Promise<string | null> {
  if (!(await isGitRepo(repoRoot))) return null;
  // Fast path: no index mutation at all.
  try {
    const stash = (await git(repoRoot, ["stash", "create", "-u"])).trim();
    if (stash && /^[0-9a-f]{4,40}$/i.test(stash)) {
      // stash create has no message; record the label via the ref only.
      await git(repoRoot, [
        "update-ref",
        `refs/codeagent/checkpoints/${id}`,
        stash,
      ]);
      return stash;
    }
  } catch {
    // Fall through to legacy path (e.g. old git without -u support).
  }
  try {
    // Stage all files temporarily to snapshot exact state
    await git(repoRoot, ["add", "-A"]);
    const tree = (await git(repoRoot, ["write-tree"])).trim();

    let commitHash: string;
    try {
      const head = (await git(repoRoot, ["rev-parse", "HEAD"])).trim();
      commitHash = (
        await git(repoRoot, ["commit-tree", tree, "-p", head, "-m", label])
      ).trim();
    } catch {
      // Empty / initial repository with no commits yet
      commitHash = (
        await git(repoRoot, ["commit-tree", tree, "-m", label])
      ).trim();
    }

    await git(repoRoot, [
      "update-ref",
      `refs/codeagent/checkpoints/${id}`,
      commitHash,
    ]);
    return commitHash;
  } catch (error) {
    // If checkpoint fails (e.g. index locked), fail gracefully without stopping the agent
    return null;
  } finally {
    // Always restore the index so a crash/error can't leave staged residue.
    try {
      await git(repoRoot, ["reset"]);
    } catch {
      // best effort
    }
  }
}

/**
 * Restores the workspace to the exact state saved in refs/codeagent/checkpoints/<id>.
 * Safety: snapshots the pre-restore state to a backup ref first, so a
 * mistaken /undo never loses post-checkpoint work (Claude Code parity:
 * stash + confirm instead of silent `clean -fd` data loss).
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
    // Backup current state (including untracked) before destructive restore.
    try {
      const backup = (await git(repoRoot, ["stash", "create", "-u"])).trim();
      if (backup && /^[0-9a-f]{4,40}$/i.test(backup)) {
        await git(repoRoot, [
          "update-ref",
          `refs/codeagent/checkpoints/backup-${id}-${Date.now()}`,
          backup,
        ]);
      }
    } catch {
      // backup best-effort; restore proceeds
    }
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
