import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getQuickDiagnostics } from "../src/agent/diagnostics.js";

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "agent-diag-"));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("getQuickDiagnostics", () => {
  it("detects TypeScript syntax errors in edited files", async () => {
    // Missing identifier after colon
    const badCode = "const x: = 123;\n";
    await fs.writeFile(path.join(tmp, "broken.ts"), badCode, "utf8");

    const diag = await getQuickDiagnostics(tmp, "broken.ts");
    expect(diag).not.toBeNull();
    expect(diag).toContain("TypeScript Syntax Errors");
    expect(diag).toContain("Line 1");
  });

  it("returns null for clean, valid TypeScript files", async () => {
    const cleanCode = "export function add(a: number, b: number): number {\n  return a + b;\n}\n";
    await fs.writeFile(path.join(tmp, "clean.ts"), cleanCode, "utf8");

    const diag = await getQuickDiagnostics(tmp, "clean.ts");
    expect(diag).toBeNull();
  });

  it("returns null for non-code files", async () => {
    await fs.writeFile(path.join(tmp, "notes.txt"), "some notes", "utf8");
    const diag = await getQuickDiagnostics(tmp, "notes.txt");
    expect(diag).toBeNull();
  });
});
