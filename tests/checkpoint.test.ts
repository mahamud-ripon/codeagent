import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CheckpointManager } from "../src/agent/checkpoint.js";

const execFileAsync = promisify(execFile);

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "agent-cp-"));
  // Initialize git repo for testing
  await execFileAsync("git", ["init"], { cwd: tmp });
  await execFileAsync("git", ["config", "core.autocrlf", "false"], { cwd: tmp });
  await execFileAsync("git", ["config", "user.email", "agent@test.local"], { cwd: tmp });
  await execFileAsync("git", ["config", "user.name", "Agent Test"], { cwd: tmp });
  // Create an initial commit
  await fs.writeFile(path.join(tmp, "initial.txt"), "initial content\n", "utf8");
  await execFileAsync("git", ["add", "initial.txt"], { cwd: tmp });
  await execFileAsync("git", ["commit", "-m", "initial commit"], { cwd: tmp });
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("CheckpointManager", () => {
  it("captures checkpoint and reverts modified files with restoreLastCheckpoint", async () => {
    const manager = new CheckpointManager(tmp);

    // Save baseline checkpoint
    const cp = await manager.saveCheckpoint("baseline");
    expect(cp).not.toBeNull();
    expect(cp?.id).toMatch(/^cp-/);

    // Agent modifies file and creates a new one
    await fs.writeFile(path.join(tmp, "initial.txt"), "modified by agent\n", "utf8");
    await fs.writeFile(path.join(tmp, "new_file.txt"), "new file created\n", "utf8");

    // Verify changes are in working directory
    expect(await fs.readFile(path.join(tmp, "initial.txt"), "utf8")).toBe("modified by agent\n");
    expect(await fs.readFile(path.join(tmp, "new_file.txt"), "utf8")).toBe("new file created\n");

    // Revert via checkpoint
    const restored = await manager.restoreLastCheckpoint();
    expect(restored).not.toBeNull();
    expect(restored?.label).toBe("baseline");

    // Verify initial file was restored and newly created file was cleaned
    const initialContent = await fs.readFile(path.join(tmp, "initial.txt"), "utf8");
    expect(initialContent.replace(/\r\n/g, "\n")).toBe("initial content\n");
    const fileExists = await fs.stat(path.join(tmp, "new_file.txt")).then(() => true).catch(() => false);
    expect(fileExists).toBe(false);
  });

  it("lists multiple checkpoints and supports restoring by id", async () => {
    const manager = new CheckpointManager(tmp);

    await fs.writeFile(path.join(tmp, "state.txt"), "v1\n", "utf8");
    const cp1 = await manager.saveCheckpoint("step 1");

    await fs.writeFile(path.join(tmp, "state.txt"), "v2\n", "utf8");
    const cp2 = await manager.saveCheckpoint("step 2");

    await fs.writeFile(path.join(tmp, "state.txt"), "v3\n", "utf8");

    expect(manager.listCheckpoints().length).toBe(2);

    // Restore to step 1
    const ok = await manager.restoreCheckpoint(cp1!.id);
    expect(ok).toBe(true);
    const stateContent = await fs.readFile(path.join(tmp, "state.txt"), "utf8");
    expect(stateContent.replace(/\r\n/g, "\n")).toBe("v1\n");
  });

  it("handles non-git repositories gracefully without throwing", async () => {
    const nonGitTmp = await fs.mkdtemp(path.join(os.tmpdir(), "agent-nongit-"));
    try {
      const manager = new CheckpointManager(nonGitTmp);
      const cp = await manager.saveCheckpoint("test");
      expect(cp).toBeNull();
      const restored = await manager.restoreLastCheckpoint();
      expect(restored).toBeNull();
    } finally {
      await fs.rm(nonGitTmp, { recursive: true, force: true });
    }
  });
});
