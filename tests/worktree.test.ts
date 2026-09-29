import { describe, expect, it } from "vitest";
import path from "node:path";
import { resolveMainRootFromWorktree, sanitizeSlug } from "../src/tools/worktree.js";

describe("resolveMainRootFromWorktree", () => {
  it("resolves the main repo root from a worktree three levels deep", () => {
    const root = path.resolve("D:/projects/my-app");
    const worktree = path.join(root, ".codeagent", "worktrees", "feat-auth");
    expect(resolveMainRootFromWorktree(worktree)).toBe(root);
  });

  it("resolves relative to the input when nested deeper in the tree", () => {
    // Defensive: even for non-standard layouts the function resolves
    // deterministically three levels up.
    const worktree = path.resolve("D:/a/b/c/d/slug");
    expect(resolveMainRootFromWorktree(worktree)).toBe(path.resolve("D:/a/b"));
  });
});

describe("sanitizeSlug", () => {
  it("lowercases and slugifies", () => {
    expect(sanitizeSlug("Feat Auth!")).toBe("feat-auth");
  });

  it("caps length at 40 characters", () => {
    expect(sanitizeSlug("x".repeat(80)).length).toBeLessThanOrEqual(40);
  });

  it("falls back to 'task' when nothing remains", () => {
    expect(sanitizeSlug("!!!")).toBe("task");
  });
});
