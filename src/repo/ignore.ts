/**
 * Central ignore rules shared by list_files, search, and the repo scanner.
 * Keep the model from wasting context on build output / dependencies.
 */
export const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  "coverage",
  ".cache",
  ".turbo",
  ".vite",
  "out",
]);

/** File names the agent must never intentionally read. */
export const SECRET_FILENAMES = new Set([
  ".env",
  ".env.local",
  ".env.production",
  "id_rsa",
  "id_ed25519",
  ".pem",
]);

/** Lowercase substrings that mark a path as secret-ish. */
const SECRET_SUBSTRINGS = [
  ".ssh/",
  ".aws/credentials",
  ".env",
  "id_rsa",
  "id_ed25519",
  ".pem",
  "cloud credential",
];

export function isIgnoredDir(name: string): boolean {
  return IGNORED_DIRS.has(name);
}

/** Best-effort guard: refuse obviously secret paths before reading. */
export function isSecretPath(repoRelativePath: string): boolean {
  const normalized = repoRelativePath.replace(/\\/g, "/").toLowerCase();
  const base = normalized.split("/").pop() ?? normalized;
  if (SECRET_FILENAMES.has(base)) return true;
  if (base.endsWith(".pem")) return true;
  return SECRET_SUBSTRINGS.some((s) => normalized.includes(s));
}

/** Extra rg --glob flags derived from IGNORED_DIRS. */
export function ripgrepIgnoreGlobs(): string[] {
  const globs: string[] = ["!.git/**"];
  for (const dir of IGNORED_DIRS) {
    if (dir !== ".git") globs.push(`!${dir}/**`);
  }
  return globs;
}
