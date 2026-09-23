import fs from "node:fs/promises";
import path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { resolveInsideRepo } from "../utils/paths.js";

const execAsync = promisify(exec);

export interface DiagnosticResult {
  hasErrors: boolean;
  errors: string[];
  summary: string;
}

/**
 * Checks for syntax and compiler errors on an edited or written TypeScript/JavaScript file.
 * Fast, non-blocking (max 3s timeout), returns null if clean or unsupported.
 */
export async function getQuickDiagnostics(
  repoRoot: string,
  filePath: string,
): Promise<string | null> {
  const ext = path.extname(filePath).toLowerCase();
  if (![".ts", ".tsx", ".js", ".jsx"].includes(ext)) {
    return null;
  }

  const absolute = resolveInsideRepo(repoRoot, filePath);
  let content: string;
  try {
    content = await fs.readFile(absolute, "utf8");
  } catch {
    return null;
  }

  // 1. Fast in-process syntactic check via TypeScript API if available
  try {
    const ts = await import("typescript");
    const compiler = ts.default || ts;
    const compilerOptions: import("typescript").CompilerOptions = {};
    if (ext.endsWith("x")) {
      compilerOptions.jsx = compiler.JsxEmit.ReactJSX;
    }
    const transpileResult = compiler.transpileModule(content, {
      reportDiagnostics: true,
      compilerOptions,
    });

    if (transpileResult.diagnostics && transpileResult.diagnostics.length > 0) {
      const syntaxErrors: string[] = [];
      for (const diag of transpileResult.diagnostics.slice(0, 4)) {
        const msg = typeof diag.messageText === "string"
          ? diag.messageText
          : diag.messageText.messageText;
        const line = diag.file && diag.start !== undefined
          ? diag.file.getLineAndCharacterOfPosition(diag.start).line + 1
          : 1;
        syntaxErrors.push(`  - Line ${line}: ${msg} (TS${diag.code})`);
      }
      if (syntaxErrors.length > 0) {
        return `⚠️ TypeScript Syntax Errors:\n${syntaxErrors.join("\n")}`;
      }
    }
  } catch {
    // TypeScript module not found or failed to load — fallback to compiler run
  }

  // 2. Check for tsconfig.json to run quick typecheck
  const hasTsConfig = await fs.stat(path.join(repoRoot, "tsconfig.json")).then(() => true).catch(() => false);
  if (!hasTsConfig) {
    return null;
  }

  try {
    // Run tsc --noEmit with a strict 3000ms timeout
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);

    const normTarget = filePath.replace(/\\/g, "/").toLowerCase();
    const basename = path.basename(filePath).toLowerCase();

    try {
      await execAsync("npx tsc --noEmit --pretty false", {
        cwd: repoRoot,
        signal: controller.signal,
        timeout: 3000,
        maxBuffer: 1024 * 1024,
      });
      clearTimeout(timeout);
      return null; // clean!
    } catch (err: unknown) {
      clearTimeout(timeout);
      const output = (err as { stdout?: string; stderr?: string }).stdout ?? "";
      if (!output) return null;

      const lines = output.split("\n");
      const relevantErrors: string[] = [];

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const lower = trimmed.toLowerCase();
        if (lower.includes(normTarget) || lower.includes(basename)) {
          // Format e.g. "src/app.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'."
          const match = trimmed.match(/\((\d+),\d+\):\s*(error\s+TS\d+:\s*.+)$/);
          if (match) {
            relevantErrors.push(`  - Line ${match[1]}: ${match[2]}`);
          } else {
            relevantErrors.push(`  - ${trimmed}`);
          }
          if (relevantErrors.length >= 4) break;
        }
      }

      if (relevantErrors.length > 0) {
        return `⚠️ Compiler Type Diagnostics:\n${relevantErrors.join("\n")}`;
      }
      return null;
    }
  } catch {
    return null;
  }
}
