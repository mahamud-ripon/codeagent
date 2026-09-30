import fs from "node:fs/promises";
import path from "node:path";

/** AG-10: detect project test/lint/typecheck commands + extend in-loop diagnostics. */

export interface VerifyCommands {
  test?: string;
  lint?: string;
  typecheck?: string;
}

export async function detectVerifyCommands(repoRoot: string, memoryText?: string): Promise<VerifyCommands> {
  const out: VerifyCommands = {};
  // Memory file hints win (explicit project convention).
  const mem = memoryText ?? "";
  const memTest = mem.match(/test\s*:\s*(.+)/i)?.[1]?.trim();
  if (memTest) out.test = memTest.slice(0, 200);

  try {
    const pkgRaw = await fs.readFile(path.join(repoRoot, "package.json"), "utf8");
    const pkg = JSON.parse(pkgRaw) as { scripts?: Record<string, string> };
    const scripts = pkg.scripts ?? {};
    if (!out.test && scripts.test) out.test = "npm test";
    else if (!out.test && scripts["test:unit"]) out.test = "npm run test:unit";
    if (scripts.lint) out.lint = "npm run lint";
    else if (scripts["lint:js"]) out.lint = "npm run lint:js";
    if (scripts.typecheck) out.typecheck = "npm run typecheck";
    else if (scripts.build) out.typecheck = "npm run build";
    else out.typecheck ??= "npx tsc --noEmit";
    return out;
  } catch {
    // not a node project; fall through
  }
  const exists = async (p: string): Promise<boolean> => {
    try { await fs.stat(path.join(repoRoot, p)); return true; } catch { return false; }
  };
  if (await exists("pyproject.toml") || await exists("requirements.txt")) {
    out.test ??= "pytest";
    out.lint ??= "ruff check .";
    out.typecheck ??= "pyright";
    return out;
  }
  if (await exists("go.mod")) {
    out.test ??= "go test ./...";
    out.lint ??= "go vet ./...";
    return out;
  }
  if (await exists("Cargo.toml")) {
    out.test ??= "cargo test";
    out.lint ??= "cargo clippy";
    out.typecheck ??= "cargo check";
    return out;
  }
  if (await exists("Makefile")) {
    out.test ??= "make test";
    out.lint ??= "make lint";
  }
  return out;
}

export function commandForKind(cmds: VerifyCommands, kind: "test" | "lint" | "typecheck"): string | undefined {
  return cmds[kind];
}
