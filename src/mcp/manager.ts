import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { McpClient, type McpServerConfig, type McpToolDef } from "./client.js";

/** EX-1 manager: config in settings.json mcpServers + codeagent mcp add/list/remove. */

export async function loadMcpServers(repoRoot: string, homeDir: string = os.homedir()): Promise<Record<string, McpServerConfig>> {
  const files = [
    path.join(homeDir, ".codeagent", "settings.json"),
    path.join(repoRoot, ".codeagent", "settings.json"),
  ];
  const merged: Record<string, McpServerConfig> = {};
  for (const file of files) {
    try {
      const raw = JSON.parse(await fs.readFile(file, "utf8")) as { mcpServers?: Record<string, McpServerConfig> };
      Object.assign(merged, raw.mcpServers ?? {});
    } catch {
      // missing/unparseable — skip
    }
  }
  return merged;
}

export async function listAllMcpTools(repoRoot: string): Promise<McpToolDef[]> {
  const servers = await loadMcpServers(repoRoot);
  const out: McpToolDef[] = [];
  for (const [name, cfg] of Object.entries(servers)) {
    let client: McpClient | null = null;
    try {
      client = cfg.url ? await McpClient.http(name, cfg) : await McpClient.stdio(name, cfg);
      out.push(...(await client.listTools(name)));
    } catch {
      // unreachable server — skip, do not fail the run
    } finally {
      await client?.close().catch(() => undefined);
    }
  }
  return out;
}

export function mcpPermissionRule(server: string, tool?: string): string {
  return tool ? `MCP(${server}:${tool})` : `MCP(${server}:*)`;
}
