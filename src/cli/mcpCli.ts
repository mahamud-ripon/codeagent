import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadMcpServers, listAllMcpTools } from "../mcp/manager.js";

/** codeagent mcp add/list/remove (EX-1). */

function settingsPath(repoRoot: string): string {
  return path.join(repoRoot, ".codeagent", "settings.json");
}

export async function runMcpCli(args: string[], repoRoot: string): Promise<void> {
  const [sub, ...rest] = args;
  if (sub === "list") {
    const tools = await listAllMcpTools(repoRoot).catch(() => []);
    const servers = await loadMcpServers(repoRoot).catch(() => ({}));
    const names = Object.keys(servers);
    if (names.length === 0) {
      console.log("No MCP servers configured. Use: codeagent mcp add <name> -- <command> [args...]");
      return;
    }
    console.log(`MCP servers (${names.length}):`);
    for (const n of names) console.log(`  - ${n}`);
    if (tools.length) {
      console.log(`Tools (${tools.length}):`);
      for (const t of tools.slice(0, 50)) console.log(`  - ${t.namespaced}`);
    }
    return;
  }
  if (sub === "add") {
    const name = rest[0];
    const dash = rest.indexOf("--");
    const command = dash >= 0 ? rest.slice(dash + 1) : rest.slice(1);
    if (!name || command.length === 0) {
      console.error("Usage: codeagent mcp add <name> -- <command> [args...]");
      process.exit(4);
    }
    const file = settingsPath(repoRoot);
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
    } catch {
      // fresh file
    }
    const servers = (json.mcpServers as Record<string, unknown> | undefined) ?? {};
    servers[name] = { command: command[0], args: command.slice(1) };
    json.mcpServers = servers;
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(json, null, 2));
    console.log(`Added MCP server "${name}".`);
    return;
  }
  if (sub === "remove") {
    const name = rest[0];
    if (!name) {
      console.error("Usage: codeagent mcp remove <name>");
      process.exit(4);
    }
    const file = settingsPath(repoRoot);
    try {
      const json = JSON.parse(await fs.readFile(file, "utf8")) as { mcpServers?: Record<string, unknown> };
      if (json.mcpServers) delete json.mcpServers[name];
      await fs.writeFile(file, JSON.stringify(json, null, 2));
      console.log(`Removed MCP server "${name}".`);
    } catch {
      console.error(`No settings found at ${file}.`);
      process.exit(4);
    }
    return;
  }
  console.log("Usage: codeagent mcp <add|list|remove>");
  void os.homedir;
}
