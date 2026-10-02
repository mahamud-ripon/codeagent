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

/**
 * Phase 2 hygiene: extra ignores that never reach the model.
 * audit.jsonl must never go to the model. Gated behind the hygiene flag
 * so the default tree (flags off) matches the Phase 3 baseline.
 */
export const HYGIENE_IGNORED_DIRS = new Set([
  ".codeagent",
  ".ruff_cache",
  ".pytest_cache",
  "__pycache__",
  ".mypy_cache",
  ".venv",
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

export function isIgnoredDir(name: string, hygieneOn = false): boolean {
  if (IGNORED_DIRS.has(name)) return true;
  if (hygieneOn && HYGIENE_IGNORED_DIRS.has(name)) return true;
  return false;
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
export function ripgrepIgnoreGlobs(hygieneOn = false): string[] {
  const globs: string[] = ["!.git/**"];
  for (const dir of IGNORED_DIRS) {
    if (dir !== ".git") globs.push(`!${dir}/**`);
  }
  if (hygieneOn) {
    for (const dir of HYGIENE_IGNORED_DIRS) globs.push(`!${dir}/**`);
  }
  return globs;
}
