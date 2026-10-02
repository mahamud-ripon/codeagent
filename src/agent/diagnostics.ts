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
 * AG-10: extends beyond tsc to eslint, ruff/pyright, go vet, cargo check.
 */
export async function getQuickDiagnostics(
  repoRoot: string,
  filePath: string,
): Promise<string | null> {
  // Overall 6s ceiling: Python path runs ruff+py_compile sequentially (9s
  // worst), tsc whole-project can stall — never block the agent loop.
  const inner = getQuickDiagnosticsInner(repoRoot, filePath);
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 6000));
  try {
    return await Promise.race([inner, timeout]);
  } catch {
    return null;
  }
}

async function getQuickDiagnosticsInner(
  repoRoot: string,
  filePath: string,
): Promise<string | null> {
  const ext = path.extname(filePath).toLowerCase();
  // Python: ruff / pyright when available (best-effort, 3s each).
  if (ext === ".py") {
    return getPythonDiagnostics(repoRoot, filePath);
  }
  // Go: go vet on the owning package (best-effort).
  if (ext === ".go") {
    return getGoDiagnostics(repoRoot, filePath);
  }
  // Rust: cargo check filtered to the file (best-effort).
  if (ext === ".rs") {
    return getRustDiagnostics(repoRoot, filePath);
  }
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

  // Config files are not application source modules: do not run project tsc or eslint on them
  const baseName = path.basename(filePath).toLowerCase();
  if (
    baseName.includes(".config.") ||
    baseName.startsWith(".eslintrc") ||
    baseName.startsWith(".prettierrc") ||
    baseName.startsWith(".babelrc") ||
    baseName === "package.json" ||
    baseName === "tsconfig.json"
  ) {
    return null;
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
      await execAsync("npx --no-install tsc --noEmit --pretty false", {
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
      // AG-10: eslint is the JS-side lint complement to tsc (best-effort).
      try {
        const hasEslint = await fs.stat(path.join(repoRoot, "node_modules", "eslint")).then(() => true).catch(() => false);
        if (hasEslint) {
          const { stdout } = await execAsync(`npx --no-install eslint ${JSON.stringify(filePath)} --format unix`, {
            cwd: repoRoot,
            timeout: 3000,
            maxBuffer: 512 * 1024,
          }).catch((e: unknown) => ({ stdout: (e as { stdout?: string }).stdout ?? "" }));
          const eslintLines = String(stdout ?? "").split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 4);
          if (eslintLines.length > 0) return `⚠️ ESLint:\n${eslintLines.map((l) => `  - ${l}`).join("\n")}`;
        }
      } catch {
        // eslint not installed — ignore
      }
      return null;
    }
  } catch {
    return null;
  }
}

async function runBestEffort(cmd: string, repoRoot: string, timeoutMs = 3000): Promise<string | null> {
  try {
    await execAsync(cmd, { cwd: repoRoot, timeout: timeoutMs, maxBuffer: 512 * 1024 });
    // Exit code 0 indicates success / no compiler or lint errors.
    // Clean output (e.g. "All checks passed!") must NEVER be treated as an error.
    return null;
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; killed?: boolean; code?: number | string };
    if (err.killed) return null;
    // POSIX exit code 127 = command not found; ENOENT = binary missing
    if (err.code === 127 || err.code === "ENOENT") return null;
    const out = [err.stdout, err.stderr].filter(Boolean).join("\n").trim();
    if (!out) return null;
    // If the command failed because the tool is not installed or command not found, ignore it.
    if (
      /not recognized as an internal or external command/i.test(out) ||
      /is not recognized as the name of a cmdlet/i.test(out) ||
      /not found/i.test(out) ||
      /cannot find the file specified/i.test(out) ||
      /No such file or directory/i.test(out)
    ) {
      return null;
    }
    const lines = out
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !/all checks passed/i.test(l) && !/^0 errors/i.test(l))
      .slice(0, 4);
    if (lines.length === 0) return null;
    return lines.map((l) => `  - ${l}`).join("\n");
  }
}

/** AG-10: Python diagnostics via ruff, falling back to python -m py_compile. */
async function getPythonDiagnostics(repoRoot: string, filePath: string): Promise<string | null> {
  const abs = resolveInsideRepo(repoRoot, filePath);
  try {
    await fs.readFile(abs, "utf8");
  } catch {
    return null;
  }
  // 1. Try ruff check (fastest linter/syntax checker) + py_compile in
  // parallel — sequential was 9s worst-case and blocked the loop.
  const [ruff, pyCompile] = await Promise.all([
    runBestEffort(`ruff check ${JSON.stringify(filePath)}`, repoRoot),
    (async (): Promise<string | null> =>
      (await runBestEffort(`python -m py_compile ${JSON.stringify(filePath)}`, repoRoot)) ??
      (await runBestEffort(`python3 -m py_compile ${JSON.stringify(filePath)}`, repoRoot)))(),
  ]);
  if (ruff) return `⚠️ Ruff:\n${ruff}`;
  if (pyCompile) return `⚠️ Python Syntax Error:\n${pyCompile}`;

  return null;
}

/** AG-10: Go diagnostics via go vet on the file's directory. */
async function getGoDiagnostics(repoRoot: string, filePath: string): Promise<string | null> {
  const dir = path.dirname(resolveInsideRepo(repoRoot, filePath));
  const relDir = path.relative(repoRoot, dir) || ".";
  const out = await runBestEffort(`go vet ./${relDir.replace(/\\/g, "/")}`, repoRoot);
  if (out) return `⚠️ go vet:\n${out}`;
  return null;
}

/** AG-10: Rust diagnostics via cargo check, filtered to the file. */
export async function getRustDiagnostics(repoRoot: string, filePath: string): Promise<string | null> {
  const out = await runBestEffort(`cargo check --message-format short`, repoRoot, 5000);
  if (!out) return null;
  const base = path.basename(filePath).toLowerCase();
  const hits = out.split("\n").filter((l) => l.toLowerCase().includes(base)).slice(0, 4);
  const shown = (hits.length ? hits : out.split("\n").slice(0, 4)).map((l) => `  - ${l}`).join("\n");
  return shown ? `⚠️ cargo check:\n${shown}` : null;
}

/**
 * Phase 4D: `ruff check --fix` with no model turn. Runs only on files the
 * agent wrote; the contract test runs again after the fix (caller reruns
 * verification). Returns true when bytes changed. Best-effort, never throws.
 */
export async function runRuffFix(repoRoot: string, filePath: string): Promise<boolean> {
  if (!filePath.endsWith(".py")) return false;
  try {
    const before = await fs.readFile(resolveInsideRepo(repoRoot, filePath), "utf8").catch(() => null);
    if (before == null) return false;
    await runBestEffort(`ruff check --fix ${JSON.stringify(filePath)}`, repoRoot, 5000);
    const after = await fs.readFile(resolveInsideRepo(repoRoot, filePath), "utf8").catch(() => null);
    return after != null && after !== before;
  } catch {
    return false;
  }
}
