import { spawn, type ChildProcess } from "node:child_process";

/**
 * EX-1: minimal MCP client (stdio + streamable HTTP) without the official SDK.
 * Speaks JSON-RPC 2.0 tools/list + tools/call. Tools surface as mcp__server__tool.
 */

export interface McpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

export interface McpToolDef {
  server: string;
  name: string;
  namespaced: string;
  description?: string;
  inputSchema?: unknown;
}

interface Pending { resolve: (v: unknown) => void; reject: (e: Error) => void; }

export class McpClient {
  private proc?: ChildProcess;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private buffer = "";
  private url?: string;
  private headers: Record<string, string> = {};

  static async stdio(server: string, config: McpServerConfig): Promise<McpClient> {
    if (!config.command) throw new Error(`MCP server "${server}" has no command.`);
    const c = new McpClient();
    const proc = spawn(config.command, config.args ?? [], {
      env: { ...process.env, ...(config.env ?? {}) },
      stdio: ["pipe", "pipe", "inherit"],
      windowsHide: true,
    });
    c.proc = proc;
    proc.stdout?.on("data", (d: Buffer) => c.onData(d.toString()));
    proc.on("error", (e) => c.failAll(e as Error));
    await c.initialize();
    return c;
  }

  static async http(server: string, config: McpServerConfig): Promise<McpClient> {
    if (!config.url) throw new Error(`MCP server "${server}" has no url.`);
    void server;
    const c = new McpClient();
    c.url = config.url;
    c.headers = config.headers ?? {};
    await c.initialize();
    return c;
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line) as { id?: number; result?: unknown; error?: { message?: string } };
        if (msg.id !== undefined) {
          const p = this.pending.get(msg.id);
          if (p) {
            this.pending.delete(msg.id);
            if (msg.error) p.reject(new Error(`MCP: ${msg.error.message ?? "unknown error"}`));
            else p.resolve(msg.result);
          }
        }
      } catch {
        // partial frame; ignore
      }
    }
  }

  private failAll(e: Error): void {
    for (const [, p] of this.pending) p.reject(e);
    this.pending.clear();
  }

  private async send(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++;
    const body = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    if (this.url) {
      const res = await fetch(this.url, {
        method: "POST",
        headers: { "content-type": "application/json", ...this.headers },
        body,
      });
      if (!res.ok) throw new Error(`MCP HTTP ${res.status}`);
      const msg = (await res.json()) as { result?: unknown; error?: { message?: string } };
      if (msg.error) throw new Error(`MCP: ${msg.error.message ?? "error"}`);
      return msg.result;
    }
    if (!this.proc?.stdin?.writable) throw new Error("MCP stdio server not connected.");
    const done = new Promise<unknown>((resolve, reject) => this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject }));
    this.proc.stdin.write(body + "\n");
    return done;
  }

  private async initialize(): Promise<void> {
    try {
      await this.send("initialize", { protocolVersion: "2024-11-05", clientInfo: { name: "codeagent", version: "0.1.0" } });
    } catch {
      // best effort: some servers skip initialize
    }
  }

  async listTools(server: string): Promise<McpToolDef[]> {
    const res = (await this.send("tools/list")) as { tools?: Array<{ name: string; description?: string; inputSchema?: unknown }> };
    return (res.tools ?? []).map((t) => ({
      server,
      name: t.name,
      namespaced: `mcp__${server}__${t.name}`,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
  }

  async callTool(name: string, args: unknown): Promise<string> {
    const res = (await this.send("tools/call", { name, arguments: args })) as { content?: Array<{ type?: string; text?: string }> };
    const texts = (res.content ?? []).map((c) => c.text ?? "").filter(Boolean);
    return texts.join("\n") || JSON.stringify(res).slice(0, 4000);
  }

  async close(): Promise<void> {
    try { this.proc?.kill(); } catch { /* noop */ }
    this.pending.clear();
  }
}

export function namespacedToolId(server: string, tool: string): string {
  return `mcp__${server}__${tool}`;
}

export function parseNamespacedTool(id: string): { server: string; tool: string } | null {
  const m = id.match(/^mcp__([^_][^_]*)__(.+)$/);
  if (!m) return null;
  return { server: m[1]!, tool: m[2]! };
}
