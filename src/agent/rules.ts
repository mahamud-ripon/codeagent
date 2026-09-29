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
export function discoverRules(
  repoRoot: string,
  homeDir: string = os.homedir(),
  maxRules: number = 5,
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

  return loadedRules.slice(0, maxRules);
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
