import fs from "node:fs/promises";
import path from "node:path";
import { resolveInsideRepo } from "../utils/paths.js";
import { isSecretPath } from "../repo/ignore.js";

export interface SymbolEntry {
  line: number;
  kind: "class" | "interface" | "type" | "enum" | "function" | "method" | "const" | "def";
  name: string;
  signature: string;
  indent: number;
}

/**
 * Extracts a compact structural outline of exported symbols, classes,
 * methods, and functions from a source file.
 */
export async function viewSymbolOutline(repoRoot: string, filePath: string): Promise<string> {
  if (isSecretPath(filePath)) {
    throw new Error(`Refusing to access potential secret file: ${filePath}`);
  }

  const absolute = resolveInsideRepo(repoRoot, filePath);
  let content: string;
  try {
    content = await fs.readFile(absolute, "utf8");
  } catch {
    throw new Error(`File not found: ${filePath}`);
  }

  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const ext = path.extname(filePath).toLowerCase();
  const symbols: SymbolEntry[] = [];

  const isPython = ext === ".py";
  const isGo = ext === ".go";
  const isRust = ext === ".rs";
  const isJava = ext === ".java" || ext === ".kt" || ext === ".cs" || ext === ".swift" || ext === ".php" || ext === ".rb";
  const isC = ext === ".c" || ext === ".cpp" || ext === ".h" || ext === ".hpp";

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("#") || trimmed.startsWith("/*") || trimmed.startsWith("*")) {
      continue;
    }

    const leadingSpaces = (rawLine.match(/^(\s*)/)?.[1] ?? "").length;

    if (isPython) {
      // Python def or class
      const pyMatch = trimmed.match(/^(def|class)\s+([a-zA-Z0-9_]+)(?:\((.*?)\))?:/);
      if (pyMatch) {
        symbols.push({
          line: i + 1,
          kind: pyMatch[1] === "class" ? "class" : "def",
          name: pyMatch[2],
          signature: trimmed.replace(/:$/, ""),
          indent: leadingSpaces,
        });
      }
      continue;
    }

    if (isGo) {
      const goMatch = trimmed.match(/^(func)\s+(?:\([^)]*\)\s+)?([A-Za-z0-9_]+)\s*\(/) ?? trimmed.match(/^type\s+([A-Za-z0-9_]+)\s+(struct|interface)/);
      if (goMatch) {
        const name = goMatch[2] ?? goMatch[1]!;
        symbols.push({ line: i + 1, kind: name === goMatch[1] && /struct|interface/.test(trimmed) ? "class" : "function", name, signature: trimmed.replace(/\s*\{.*$/, ""), indent: leadingSpaces });
      }
      continue;
    }

    if (isRust) {
      const rsMatch = trimmed.match(/^(pub\s+)?(fn|struct|enum|trait|impl)\s+([A-Za-z0-9_]+)/);
      if (rsMatch) {
        const kind = rsMatch[2] === "fn" ? "function" : "class";
        symbols.push({ line: i + 1, kind, name: rsMatch[3]!, signature: trimmed.replace(/\s*\{.*$/, ""), indent: leadingSpaces });
      }
      continue;
    }

    if (isJava || isC) {
      const jMatch = trimmed.match(/^(?:(?:public|private|protected|static|final|async|override|virtual)\s+)*(class|interface|enum|struct)\s+([A-Za-z0-9_]+)/)
        ?? trimmed.match(/^(?:(?:public|private|protected|static|final|async)\s+)*[\w<>\[\]]+\s+([A-Za-z0-9_]+)\s*\([^;]*\)\s*(?:\{|;|$)/);
      if (jMatch) {
        const isType = /class|interface|enum|struct/.test(jMatch[1] ?? "");
        const name = isType ? jMatch[2]! : jMatch[1]!;
        symbols.push({ line: i + 1, kind: isType ? "class" : "method", name, signature: trimmed.replace(/\s*\{.*$/, "").slice(0, 160), indent: leadingSpaces });
      }
      continue;
    }

    // TypeScript / JavaScript symbols
    // 1. Exported declarations: interface, type, enum, class
    const declMatch = trimmed.match(
      /^(?:export\s+)?(interface|type|class|enum)\s+([A-Za-z0-9_]+)(?:\s+extends\s+([^{]+))?(?:\s+implements\s+([^{]+))?/,
    );
    if (declMatch) {
      const isExported = trimmed.startsWith("export");
      const kind = declMatch[1] as "interface" | "type" | "class" | "enum";
      const name = declMatch[2];
      symbols.push({
        line: i + 1,
        kind,
        name,
        signature: trimmed.replace(/\s*\{.*$/, "").replace(/;$/, ""),
        indent: leadingSpaces,
      });
      continue;
    }

    // 2. Exported functions: export [async] function name(...)
    const fnMatch = trimmed.match(/^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)\s*\(([^)]*)\)(?::\s*([^{]+))?/);
    if (fnMatch) {
      symbols.push({
        line: i + 1,
        kind: "function",
        name: fnMatch[1],
        signature: trimmed.replace(/\s*\{.*$/, ""),
        indent: leadingSpaces,
      });
      continue;
    }

    // 3. Exported const / let: export const name = (...) => or export const name: Type
    const constMatch = trimmed.match(/^(?:export\s+)(?:const|let)\s+([A-Za-z0-9_]+)(?::\s*([A-Za-z0-9_<>[\]]+))?\s*=/);
    if (constMatch) {
      symbols.push({
        line: i + 1,
        kind: "const",
        name: constMatch[1],
        signature: trimmed.split("=")[0].trim(),
        indent: leadingSpaces,
      });
      continue;
    }

    // 4. Class methods and constructor (indented within class)
    if (leadingSpaces >= 2) {
      const methodMatch = trimmed.match(
        /^(?:(public|private|protected|static|async)\s+)*(constructor|[A-Za-z0-9_]+)\s*\(([^)]*)\)(?::\s*([^{]+))?/,
      );
      if (
        methodMatch &&
        !trimmed.startsWith("if ") &&
        !trimmed.startsWith("for ") &&
        !trimmed.startsWith("while ") &&
        !trimmed.startsWith("switch ") &&
        !trimmed.startsWith("catch ")
      ) {
        symbols.push({
          line: i + 1,
          kind: "method",
          name: methodMatch[2],
          signature: trimmed.replace(/\s*\{.*$/, ""),
          indent: leadingSpaces,
        });
      }
    }
  }

  if (symbols.length === 0) {
    return `No top-level declarations or functions found in ${filePath} (${lines.length} lines).`;
  }

  const out: string[] = [`[Symbol Outline: ${filePath} (${lines.length} lines, ${symbols.length} symbols)]`];
  for (const s of symbols) {
    const pad = s.indent > 0 ? "  ".repeat(Math.min(4, Math.floor(s.indent / 2))) : "";
    out.push(`L${s.line}: ${pad}${s.signature}`);
  }

  return out.join("\n");
}
