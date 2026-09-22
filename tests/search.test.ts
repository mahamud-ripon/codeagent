import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { search } from "../src/tools/search.js";
import { writeFile } from "../src/tools/filesystem.js";

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "agent-search-"));
  await writeFile(tmp, "src/auth.ts", "export function authenticate(user: string) {\n  return user;\n}\n");
  await writeFile(tmp, "src/other.ts", "export const z = 1;\n");
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("search (ripgrep)", () => {
  it("finds matches with file:line info", async () => {
    const out = await search(tmp, "authenticate");
    expect(out).toContain("auth.ts");
    expect(out).toMatch(/:\d+:/); // file:line: shape
  });

  it("returns no-matches message instead of throwing", async () => {
    await expect(search(tmp, "zzz_no_such_symbol_zzz")).resolves.toMatch(/No matches/i);
  });

  it("rejects empty queries", async () => {
    await expect(search(tmp, "   ")).rejects.toThrow(/empty/i);
  });
});
