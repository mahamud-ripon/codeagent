import fs from "node:fs/promises";
import path from "node:path";

/**
 * Resolve a repository-relative path to an absolute path,
 * rejecting anything that escapes the repository root.
 *
 * Treat every model-generated path as untrusted.
 */
export function resolveInsideRepo(
  repoRoot: string,
  requestedPath: string,
): string {
  if (typeof requestedPath !== "string") {
    throw new Error("Path must be a string");
  }

  const normalized = requestedPath.trim() === "" ? "." : requestedPath.trim();
  const root = path.resolve(repoRoot);
  const resolved = path.resolve(root, normalized);

  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`Path escapes repository: ${requestedPath}`);
  }

  return resolved;
}

/**
 * Follow the nearest existing ancestor and reject a symlink that leaves the repo.
 * Missing files are allowed so write_file can create them.
 */
export async function assertRealpathInsideRepo(repoRoot: string, absolute: string): Promise<void> {
  const root = path.resolve(repoRoot);
  let realRoot = root;
  try {
    realRoot = await fs.realpath(root);
  } catch {
    // The root itself may not exist in tests that only resolve paths.
  }

  let cursor = absolute;
  for (let i = 0; i < 64; i++) {
    try {
      const real = await fs.realpath(cursor);
      if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
        throw new Error(`Path escapes repository via symlink: ${absolute}`);
      }
      return;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Path escapes")) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") return;
      const parent = path.dirname(cursor);
      if (parent === cursor) return;
      cursor = parent;
    }
  }
}
