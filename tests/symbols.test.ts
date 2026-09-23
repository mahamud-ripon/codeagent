import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { viewSymbolOutline } from "../src/tools/symbols.js";

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "agent-sym-"));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("viewSymbolOutline", () => {
  it("extracts exported interfaces, classes, methods, and functions from TypeScript", async () => {
    const tsCode = [
      "export interface UserConfig {",
      "  name: string;",
      "}",
      "",
      "export class UserService {",
      "  constructor(private config: UserConfig) {}",
      "",
      "  public async getUser(id: string): Promise<UserConfig> {",
      "    return this.config;",
      "  }",
      "}",
      "",
      "export function createService(): UserService {",
      "  return new UserService({ name: 'test' });",
      "}",
    ].join("\n");

    await fs.writeFile(path.join(tmp, "service.ts"), tsCode, "utf8");

    const outline = await viewSymbolOutline(tmp, "service.ts");
    expect(outline).toContain("Symbol Outline: service.ts");
    expect(outline).toContain("L1: export interface UserConfig");
    expect(outline).toContain("L5: export class UserService");
    expect(outline).toContain("L6:   constructor(private config: UserConfig)");
    expect(outline).toContain("L8:   public async getUser(id: string): Promise<UserConfig>");
    expect(outline).toContain("L13: export function createService(): UserService");
  });

  it("extracts classes and functions from Python files", async () => {
    const pyCode = [
      "class DataProcessor:",
      "    def __init__(self, data):",
      "        self.data = data",
      "",
      "    def process(self):",
      "        return self.data.strip()",
      "",
      "def run_all():",
      "    pass",
    ].join("\n");

    await fs.writeFile(path.join(tmp, "processor.py"), pyCode, "utf8");

    const outline = await viewSymbolOutline(tmp, "processor.py");
    expect(outline).toContain("Symbol Outline: processor.py");
    expect(outline).toContain("class DataProcessor");
    expect(outline).toContain("def __init__(self, data)");
    expect(outline).toContain("def process(self)");
    expect(outline).toContain("def run_all()");
  });

  it("refuses access to secret paths", async () => {
    await expect(viewSymbolOutline(tmp, ".env")).rejects.toThrow(/secret/i);
  });
});
