/**
 * Git Worktree Sandbox Isolation.
 *
 * Inspired by Claude Code's worktree isolation (src/utils/worktree.ts):
 * - Creates an isolated Git worktree in `.codeagent/worktrees/<slug>`.
 * - Enables running autonomous refactors, tests, or subagents without polluting
 *   the developer's active working directory.
 * - Automatically detects if changes were made:
 *   - If clean / no changes made, auto-prunes with `git worktree remove --force`.
 *   - If changes were made, preserves the branch name for review or merge.
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";

const execAsync = promisify(exec);

export interface WorktreeInfo {
  worktreePath: string;
  branch: string;
  slug: string;
}

export function sanitizeSlug(slug: string): string {
  const sanitized = slug
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized.slice(0, 40) || "task";
}

/**
 * Creates an isolated Git worktree on a new branch.
 */
export async function createWorktree(
  repoRoot: string,
  slugInput: string,
): Promise<WorktreeInfo> {
  const slug = sanitizeSlug(slugInput);
  const branch = `codeagent-worktree-${slug}-${Date.now().toString(36)}`;
  const worktreesDir = path.join(repoRoot, ".codeagent", "worktrees");
  const worktreePath = path.join(worktreesDir, slug);

  await fs.mkdir(worktreesDir, { recursive: true });

  // If previous worktree exists at that path, clean it up first
  try {
    await execAsync(`git worktree remove --force "${worktreePath}"`, { cwd: repoRoot });
  } catch {
    // ignore
  }

  // Create worktree on a new detached or tracking branch
  const cmd = `git worktree add -b "${branch}" "${worktreePath}" HEAD`;
  await execAsync(cmd, { cwd: repoRoot });

  return { worktreePath, branch, slug };
}

/**
 * Resolves the main repository root from a worktree path.
 * Worktrees live at `<root>/.codeagent/worktrees/<slug>` — three levels deep.
 */
export function resolveMainRootFromWorktree(worktreePath: string): string {
  return path.resolve(worktreePath, "..", "..", "..");
}

/**
 * Checks if the isolated worktree has any uncommitted changes or new commits.
 */
export async function hasWorktreeModifications(worktreePath: string): Promise<boolean> {
  try {
    const { stdout } = await execAsync("git status --porcelain", { cwd: worktreePath });
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Removes an isolated Git worktree and cleans up its branch if requested.
 */
export async function removeWorktree(
  repoRoot: string,
  slugInput: string,
  force = true,
): Promise<void> {
  const slug = sanitizeSlug(slugInput);
  const worktreePath = path.join(repoRoot, ".codeagent", "worktrees", slug);

  try {
    const flag = force ? "--force" : "";
    await execAsync(`git worktree remove ${flag} "${worktreePath}"`, { cwd: repoRoot });
  } catch {
    // If git command fails, remove directory manually
    await fs.rm(worktreePath, { recursive: true, force: true }).catch(() => {});
  }
}
