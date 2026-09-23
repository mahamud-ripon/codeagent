import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readFile, viewFile, writeFile, editFile, listFiles } from "../src/tools/filesystem.js";
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

  it("viewFile formats with line numbers and supports line ranges", async () => {
    const lines = ["line 1", "line 2", "line 3", "line 4", "line 5"].join("\n");
    await writeFile(tmp, "lines.txt", lines);

    const full = await viewFile(tmp, "lines.txt");
    expect(full).toContain("1 | line 1");
    expect(full).toContain("5 | line 5");

    const partial = await viewFile(tmp, "lines.txt", { startLine: 2, endLine: 4 });
    expect(partial).toContain("lines 2-4 of 5");
    expect(partial).toContain("2 | line 2");
    expect(partial).toContain("4 | line 4");
    expect(partial).not.toContain("1 | line 1");
    expect(partial).not.toContain("5 | line 5");
  });

  it("editFile handles CRLF and LF line ending differences seamlessly", async () => {
    // Disk has Windows CRLF
    await writeFile(tmp, "crlf.txt", "function test() {\r\n  return 1;\r\n}\r\n");
    // LLM sends Unix LF
    const oldSnippet = "function test() {\n  return 1;\n}";
    const newSnippet = "function test() {\n  return 2;\n}";
    expect(await editFile(tmp, "crlf.txt", oldSnippet, newSnippet)).toMatch(/Edited/);

    const content = await readFile(tmp, "crlf.txt");
    expect(content).toContain("return 2;");
  });

  it("editFile handles trailing whitespace differences seamlessly", async () => {
    // Disk has trailing whitespace on line 1
    await writeFile(tmp, "trailing.txt", "const a = 1;   \nconst b = 2;\n");
    // LLM sends clean line without trailing space
    const oldSnippet = "const a = 1;\nconst b = 2;";
    const newSnippet = "const a = 10;\nconst b = 20;";
    expect(await editFile(tmp, "trailing.txt", oldSnippet, newSnippet)).toMatch(/Edited/);

    const content = await readFile(tmp, "trailing.txt");
    expect(content).toContain("const a = 10;");
  });

  it("editFile adapts indentation to match target file indentation", async () => {
    const fileContent = "class Example {\n    doSomething() {\n        return 1;\n    }\n}\n";
    await writeFile(tmp, "indent.ts", fileContent);
    // LLM sends code with 2 spaces indentation instead of 8
    const oldSnippet = "doSomething() {\n  return 1;\n}";
    const newSnippet = "doSomething() {\n  return 42;\n}";
    const res = await editFile(tmp, "indent.ts", oldSnippet, newSnippet);
    expect(res).toContain("Edited");
    const updated = await readFile(tmp, "indent.ts");
    expect(updated).toContain("        return 42;");
  });

  it("editFile matches via fuzzy similarity when surrounding context has minor differences", async () => {
    const fileContent = [
      "function computePrice(item: Item) {",
      "  // calculate base price with tax",
      "  const base = item.price * 1.20;",
      "  const discount = item.discount || 0;",
      "  return base - discount;",
      "}",
    ].join("\n");
    await writeFile(tmp, "fuzzy.ts", fileContent);

    // LLM slightly misremembered comment and variable spacing
    const oldSnippet = [
      "function computePrice(item: Item) {",
      "  // calculate base price with taxes",
      "  const base = item.price * 1.20;",
      "  const discount = item.discount || 0;",
      "  return base - discount;",
      "}",
    ].join("\n");
    const newSnippet = [
      "function computePrice(item: Item) {",
      "  const base = item.price * 1.25;",
      "  return base;",
      "}",
    ].join("\n");

    const res = await editFile(tmp, "fuzzy.ts", oldSnippet, newSnippet);
    expect(res).toContain("strategy: fuzzy_similarity");
    const updated = await readFile(tmp, "fuzzy.ts");
    expect(updated).toContain("1.25");
  });

  it("editFile supports unified diff hunks", async () => {
    const fileContent = "export function run() {\n  console.log('step 1');\n  console.log('step 2');\n}\n";
    await writeFile(tmp, "diff.ts", fileContent);

    const diffHunk = [
      "@@ -1,4 +1,4 @@",
      " export function run() {",
      "   console.log('step 1');",
      "-  console.log('step 2');",
      "+  console.log('step 2 modified');",
      " }",
    ].join("\n");

    const res = await editFile(tmp, "diff.ts", "", diffHunk);
    expect(res).toContain("strategy: unified_diff");
    const updated = await readFile(tmp, "diff.ts");
    expect(updated).toContain("step 2 modified");
  });

  it("rejects invalid JSON syntax during pre-flight validation", async () => {
    await expect(writeFile(tmp, "bad.json", "{\n  \"foo\": 1,\n}")).rejects.toThrow(/JSON syntax validation/);
  });

  it("rejects unclosed brackets in TypeScript during pre-flight validation", async () => {
    await expect(writeFile(tmp, "broken.ts", "function test() {\n  return 1;\n")).rejects.toThrow(/unclosed '{'/);
  });
});
