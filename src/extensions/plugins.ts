import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

/** EX-5: plugin bundles from a git URL into ~/.codeagent/plugins/<name>. */

export function pluginDir(name: string, homeDir: string = os.homedir()): string {
  return path.join(homeDir, ".codeagent", "plugins", name);
}

export async function installPlugin(gitUrl: string, name?: string, homeDir: string = os.homedir()): Promise<string> {
  const inferred = name ?? gitUrl.split("/").pop()?.replace(/\.git$/, "") ?? "plugin";
  const dir = pluginDir(inferred, homeDir);
  await fs.mkdir(path.dirname(dir), { recursive: true });
  try {
    await execAsync(`git clone --depth 1 ${JSON.stringify(gitUrl)} ${JSON.stringify(dir)}`, { timeout: 60_000 });
  } catch (e) {
    throw new Error(`Plugin install failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  return dir;
}

export async function listPlugins(homeDir: string = os.homedir()): Promise<string[]> {
  try {
    return await fs.readdir(path.join(homeDir, ".codeagent", "plugins"));
  } catch {
    return [];
  }
}

export async function removePlugin(name: string, homeDir: string = os.homedir()): Promise<void> {
  await fs.rm(pluginDir(name, homeDir), { recursive: true, force: true });
}
