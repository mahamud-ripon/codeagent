import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readFile, writeFile, editFile, listFiles } from "../src/tools/filesystem.js";
import { resolveInsideRepo } from "../src/utils/paths.js";

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "agent-fs-"));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("resolveInsideRepo", () => {
  it("rejects path traversal", () => {
    expect(() => resolveInsideRepo(tmp, "../../etc/passwd")).toThrow(/escapes/);
    expect(() => resolveInsideRepo(tmp, "../outside.txt")).toThrow(/escapes/);
  });

  it("resolves inside paths", () => {
    const abs = resolveInsideRepo(tmp, "src/a.ts");
    expect(abs.startsWith(tmp)).toBe(true);
  });
});

describe("filesystem tools", () => {
  it("write then read round-trips", async () => {
    await writeFile(tmp, "src/hello.ts", "export const x = 1;\n");
    expect(await readFile(tmp, "src/hello.ts")).toBe("export const x = 1;\n");
  });

  it("refuses secret files", async () => {
    await expect(readFile(tmp, ".env")).rejects.toThrow(/secret/i);
    await expect(writeFile(tmp, ".env", "K=1")).rejects.toThrow(/secret/i);
  });

  it("edit_file replaces exactly one occurrence", async () => {
    await writeFile(tmp, "a.txt", "foo bar foo");
    // ambiguous -> must fail, never silently pick one
    await expect(editFile(tmp, "a.txt", "foo", "baz")).rejects.toThrow(/matched 2 times/);
    await writeFile(tmp, "b.txt", "hello world");
    await expect(editFile(tmp, "b.txt", "missing", "x")).rejects.toThrow(/not found/);
    expect(await editFile(tmp, "b.txt", "world", "there")).toMatch(/Edited/);
    expect(await readFile(tmp, "b.txt")).toBe("hello there");
  });

  it("list_files skips ignored dirs", async () => {
    await writeFile(tmp, "src/keep.ts", "x");
    await writeFile(tmp, "node_modules/dep/index.js", "x");
    await writeFile(tmp, ".git/HEAD", "ref: x");
    const out = await listFiles(tmp, ".");
    expect(out).toContain("src/keep.ts");
    expect(out).not.toContain("node_modules");
    expect(out).not.toContain(".git");
  });
});
