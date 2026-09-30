import fs from "node:fs/promises";
import path from "node:path";

/**
 * AG-16: ranked repo map without native tree-sitter (zero-dep).
 * Scores files by query-term overlap, shallow depth, code extensions,
 * and modest size. Replaces the flat 2,000-file list for prompt context.
 */

export interface RankedFile { path: string; score: number }

const CODE_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs", ".java", ".rb", ".php", ".c", ".cpp", ".h", ".cs", ".swift", ".kt"]);

function tokenize(q: string): string[] {
  return q.toLowerCase().split(/[^a-z0-9_]+/).filter((t) => t.length > 2);
}

export function scoreFile(rel: string, terms: string[], sizeKb: number): number {
  const lower = rel.toLowerCase();
  let score = 0;
  for (const t of terms) {
    if (lower.includes(t)) score += 3;
    const base = path.basename(lower);
    if (base.includes(t)) score += 2;
  }
  const depth = rel.split("/").length;
  score += Math.max(0, 4 - depth); // shallow wins
  if (CODE_EXTS.has(path.extname(lower))) score += 1;
  if (/(test|spec|__tests__|\.d\.ts)/i.test(rel)) score -= 1;
  if (sizeKb > 200) score -= 2; // huge files are poor context
  return score;
}

export async function rankedRepoMap(
  repoRoot: string,
  query: string,
  files: Array<{ path: string; sizeKb?: number }>,
  limit = 30,
): Promise<RankedFile[]> {
  const terms = tokenize(query);
  void repoRoot;
  const scored = files.map((f) => ({ path: f.path, score: terms.length ? scoreFile(f.path, terms, f.sizeKb ?? 10) : 1 }));
  scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return scored.slice(0, Math.max(1, limit));
}

export async function listFilesWithSizes(repoRoot: string, limit = 2000): Promise<Array<{ path: string; sizeKb: number }>> {
  const { listFiles } = await import("../tools/filesystem.js");
  void listFiles;
  // Fallback: walk via glob tool to avoid importing UI-heavy paths.
  const { globFiles } = await import("../tools/glob.js");
  const raw = await globFiles(repoRoot, "**/*");
  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, limit);
  const out: Array<{ path: string; sizeKb: number }> = [];
  for (const rel of lines.slice(0, 300)) {
    try {
      const st = await fs.stat(path.join(repoRoot, rel));
      out.push({ path: rel, sizeKb: Math.max(1, Math.round(st.size / 1024)) });
    } catch {
      out.push({ path: rel, sizeKb: 10 });
    }
  }
  for (const rel of lines.slice(300)) out.push({ path: rel, sizeKb: 10 });
  return out;
}
