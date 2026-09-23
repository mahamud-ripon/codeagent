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
