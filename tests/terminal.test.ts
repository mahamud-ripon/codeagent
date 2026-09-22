import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCommand } from "../src/tools/terminal.js";

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "agent-term-"));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("terminal tool", () => {
  it("chains commands with the platform separator", async () => {
    const sep = process.platform === "win32" ? "&" : ";";
    const out = await runCommand(tmp, `node -e "console.log(1)" ${sep} node -e "console.log(2)"`);
    expect(out).toMatch(/^exit code: 0/);
    expect(out).toContain("1");
    expect(out).toContain("2");
  });

  it("returns non-zero exit codes instead of throwing", async () => {
    const out = await runCommand(tmp, 'node -e "process.exit(3)"');
    expect(out).toMatch(/^exit code: 3/);
  });

  it("blocks obviously destructive commands", async () => {
    await expect(runCommand(tmp, "sudo rm -rf /")).rejects.toThrow(/Blocked/);
  });

  it("rejects empty commands", async () => {
    await expect(runCommand(tmp, "   ")).rejects.toThrow(/empty/i);
  });
});
