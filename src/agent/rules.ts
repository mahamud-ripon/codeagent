import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pc } from "../cli/ui/theme.js";

export interface LoadedRule {
  filePath: string;
  category: string;
  name: string;
  content: string;
}

/**
 * Common language / framework rules matched against project indicators.
 */
function detectProjectLanguages(repoRoot: string): Set<string> {
  const categories = new Set<string>();

  try {
    const files = fs.readdirSync(repoRoot);
    const has = (name: string) => files.includes(name);

    if (
      has("tsconfig.json") ||
      files.some((f) => f.endsWith(".ts") || f.endsWith(".tsx"))
    ) {
      categories.add("typescript");
    }

    if (
      has("package.json") ||
      files.some((f) => f.endsWith(".js") || f.endsWith(".jsx"))
    ) {
      categories.add("javascript");
      categories.add("web");
    }

    if (
      has("pyproject.toml") ||
      has("requirements.txt") ||
      has("setup.py") ||
      files.some((f) => f.endsWith(".py"))
    ) {
      categories.add("python");
    }

    if (has("Cargo.toml") || files.some((f) => f.endsWith(".rs"))) {
      categories.add("rust");
    }

    if (has("go.mod") || files.some((f) => f.endsWith(".go"))) {
      categories.add("golang");
    }

    if (has("pom.xml") || has("build.gradle") || files.some((f) => f.endsWith(".java"))) {
      categories.add("java");
    }

    if (has("tailwind.config.js") || has("tailwind.config.ts") || has("tailwind.config.mjs")) {
      categories.add("tailwind");
    }
  } catch {
    // If directory cannot be read, default
  }

  return categories;
}

/**
 * Searches candidate rule directories for Markdown rule files matching active categories.
 * Prioritizes language-specific rules over generic common rules, capping at maxRules (default 5).
 */
const MEMORY_FILES = ["AGENTS.md", "CODEAGENT.md", "CLAUDE.md"];
const RULE_CHAR_BUDGET = 24_000;

export function applyCharBudget(rules: LoadedRule[], budget = RULE_CHAR_BUDGET): LoadedRule[] {
  const kept: LoadedRule[] = [];
  let used = 0;
  for (const rule of rules) {
    if (kept.length > 0 && used + rule.content.length > budget) break;
    kept.push(rule);
    used += rule.content.length;
  }
  return kept;
}

/**
 * Load AGENTS.md, CODEAGENT.md, and CLAUDE.md from the repo, its parents, and ~/.codeagent/.
 * Memory files are separate from the language rule packs.
 */
export function loadProjectMemory(repoRoot: string, homeDir: string = os.homedir()): LoadedRule[] {
  const found: LoadedRule[] = [];
  const seen = new Set<string>();
  const remember = (full: string, name: string) => {
    if (seen.has(full) || !fs.existsSync(full)) return;
    seen.add(full);
    try {
      found.push({ filePath: full, category: "memory", name, content: fs.readFileSync(full, "utf8") });
    } catch {
      // skip unreadable memory files
    }
  };

  let dir = path.resolve(repoRoot);
  const root = path.parse(dir).root;
  for (let i = 0; i < 32; i++) {
    for (const name of MEMORY_FILES) remember(path.join(dir, name), name);
    if (dir === root) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  remember(path.join(homeDir, ".codeagent", "CODEAGENT.md"), "CODEAGENT.md");
  return applyCharBudget(found, 16_000);
}

export function formatMemoryForContext(rules: LoadedRule[]): string {
  if (rules.length === 0) return "";
  const sections = rules.map((rule) => `<file path="${rule.filePath}">\n${rule.content.trim()}\n</file>`);
  return ["<project_memory>", ...sections, "</project_memory>"].join("\n");
}

/**
 * Resolve the project memory file for `#` notes and `/init` (AG-8):
 * prefer an existing AGENTS.md, then CODEAGENT.md, then CLAUDE.md;
 * otherwise a new AGENTS.md at the repo root.
 */
export function resolveMemoryFile(repoRoot: string): string {
  const root = path.resolve(repoRoot);
  for (const name of MEMORY_FILES) {
    const full = path.join(root, name);
    try {
      if (fs.existsSync(full) && fs.statSync(full).isFile()) return full;
    } catch {
      // try the next candidate
    }
  }
  return path.join(root, "AGENTS.md");
}

/**
 * Append a `#` shortcut note to the project memory file, creating it with
 * a header when missing. Returns the file path written.
 */
export function appendMemoryNote(repoRoot: string, note: string): string {
  const text = note.trim();
  if (!text) throw new Error("Cannot append an empty memory note.");
  const file = resolveMemoryFile(repoRoot);
  let existing = "";
  try {
    existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  } catch {
    existing = "";
  }
  const header = "# Project memory\n\nNotes below were added via `#` in codeagent.\n";
  const body = existing.trim() ? `${existing.replace(/\s+$/, "")}\n` : header;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${body}\n- ${text.replace(/\n+/g, " ")}\n`, "utf8");
  return file;
}

function detectTestCommand(repoRoot: string): string | null {
  try {
    const pkgFile = path.join(path.resolve(repoRoot), "package.json");
    if (fs.existsSync(pkgFile)) {
      const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8")) as { scripts?: Record<string, string> };
      if (pkg.scripts?.test) return "npm test";
      if (pkg.scripts?.build) return "npm run build";
      return "npm install";
    }
  } catch {
    // fall through the checklist
  }
  const markers: Array<[string, string]> = [
    ["pyproject.toml", "pytest"],
    ["requirements.txt", "pytest"],
    ["go.mod", "go test ./..."],
    ["Cargo.toml", "cargo test"],
    ["Makefile", "make test"],
  ];
  for (const [marker, command] of markers) {
    try {
      if (fs.existsSync(path.join(path.resolve(repoRoot), marker))) return command;
    } catch {
      // ignore
    }
  }
  return null;
}

/**
 * Generate the project memory file (`/init`, AG-8): scans languages,
 * layout, and test commands, then writes a starter AGENTS.md. Never
 * overwrites an existing memory file — returns it with created: false.
 */
export function generateMemoryFile(repoRoot: string): { file: string; created: boolean } {
  const root = path.resolve(repoRoot);
  const existing = MEMORY_FILES.map((name) => path.join(root, name)).find((full) => {
    try {
      return fs.existsSync(full) && fs.statSync(full).isFile();
    } catch {
      return false;
    }
  });
  if (existing) return { file: existing, created: false };

  const languages = [...detectProjectLanguages(root)].sort();
  const testCommand = detectTestCommand(root);
  let topLevel: string[] = [];
  try {
    topLevel = fs.readdirSync(root).filter((entry) => !entry.startsWith(".")).slice(0, 20);
  } catch {
    topLevel = [];
  }
  const lines = [
    "# Project memory",
    "",
    "Generated by codeagent `/init`. Edit freely — this file is loaded into every session.",
    "",
    "## Project",
    `- Languages/stack: ${languages.length > 0 ? languages.join(", ") : "(not detected)"}`,
    `- Top-level layout: ${topLevel.length > 0 ? topLevel.join(", ") : "(empty)"}`,
    `- Verify changes with: ${testCommand ?? "(no test command detected)"}`,
    "",
    "## Conventions",
    "- Keep edits minimal and scoped to the task.",
    "- Read a file before editing it; never guess contents.",
    "- Run the verify command after changing code.",
    "",
    "## Notes",
    "<!-- Add durable project facts below via `# your note` in the REPL. -->",
    "",
  ];
  const file = path.join(root, "AGENTS.md");
  fs.writeFileSync(file, lines.join("\n"), "utf8");
  return { file, created: true };
}

export function discoverRules(
  repoRoot: string,
  homeDir: string = os.homedir(),
  maxRules: number = 40,
): LoadedRule[] {
  const activeCategories = detectProjectLanguages(repoRoot);
  const candidateRoots: string[] = [
    // Project local rules
    path.join(repoRoot, ".codeagent", "rules"),
    path.join(repoRoot, ".claude", "rules"),
    path.join(repoRoot, "rules"),
    // User global rules
    path.join(homeDir, ".codeagent", "rules"),
    path.join(homeDir, ".claude", "rules"),
  ];

  const loadedRules: LoadedRule[] = [];
  const fallbackRules: LoadedRule[] = [];
  const seenPaths = new Set<string>();

  for (const root of candidateRoots) {
    if (!fs.existsSync(root)) continue;

    try {
      const entries = fs.readdirSync(root, { withFileTypes: true });

      for (const entry of entries) {
        if (entry.isDirectory()) {
          const category = entry.name.toLowerCase();
          const isLanguageSpecific = activeCategories.has(category);
          const isCommon = category === "common" || category === "general";

          if (isLanguageSpecific || isCommon) {
            const subDir = path.join(root, entry.name);
            const subFiles = fs.readdirSync(subDir);
            for (const f of subFiles) {
              if (f.endsWith(".md") && !f.toLowerCase().startsWith("readme")) {
                const fullPath = path.join(subDir, f);
                if (!seenPaths.has(fullPath)) {
                  seenPaths.add(fullPath);
                  try {
                    const content = fs.readFileSync(fullPath, "utf8");
                    const rule: LoadedRule = {
                      filePath: fullPath,
                      category,
                      name: f,
                      content,
                    };
                    if (isLanguageSpecific) {
                      loadedRules.push(rule);
                    } else {
                      fallbackRules.push(rule);
                    }
                  } catch {
                    // skip unreadable file
                  }
                }
              }
            }
          }
        } else if (entry.isFile() && entry.name.endsWith(".md") && !entry.name.toLowerCase().startsWith("readme")) {
          const fullPath = path.join(root, entry.name);
          if (!seenPaths.has(fullPath)) {
            seenPaths.add(fullPath);
            try {
              const content = fs.readFileSync(fullPath, "utf8");
              fallbackRules.push({
                filePath: fullPath,
                category: "general",
                name: entry.name,
                content,
              });
            } catch {
              // skip unreadable
            }
          }
        }
      }
    } catch {
      // ignore directory access errors
    }
  }

  // If fewer than maxRules loaded, supplement with fallbacks
  for (const fallback of fallbackRules) {
    if (loadedRules.length >= maxRules) break;
    loadedRules.push(fallback);
  }

  return applyCharBudget(loadedRules.slice(0, maxRules));
}

/**
 * Formats rule lines matching Claude Code's exact output:
 *   L Loaded C:\Users\RIPON MAHMUD\.claude\rules\typescript\coding-style.md
 */
export function formatLoadedRuleLine(rulePath: string): string {
  return `  ${pc.dim("L")} ${pc.dim(`Loaded ${rulePath}`)}`;
}

/**
 * Injects rule contents into system/agent context.
 */
export function formatRulesForContext(rules: LoadedRule[]): string {
  if (rules.length === 0) return "";
  const sections = rules.map(
    (r) => `<rule name="${r.category}/${r.name}">\n${r.content.trim()}\n</rule>`,
  );
  return ["<project_rules>", ...sections, "</project_rules>"].join("\n");
}
