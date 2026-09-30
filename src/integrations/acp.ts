/**
 * HL-5: minimal ACP (Agent Client Protocol) stdio bridge.
 * Speaks newline-delimited JSON-RPC: initialize / agent/run / agent/cancel.
 * A VS Code extension or GitHub Action can drive CodeAgent over stdio.
 */
import { Agent } from "../agent/agent.js";
import { PermissionManager } from "../agent/permissions.js";

interface RpcMsg { id?: number | string; method?: string; params?: Record<string, unknown> }

function reply(id: number | string | undefined, result: unknown): void {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

function fail(id: number | string | undefined, message: string): void {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message } }) + "\n");
}

export async function startAcpServer(repoRoot: string = process.cwd()): Promise<void> {
  let controller: AbortController | null = null;
  let buffer = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let msg: RpcMsg;
      try {
        msg = JSON.parse(line) as RpcMsg;
      } catch {
        continue;
      }
      const id = msg.id;
      try {
        if (msg.method === "initialize") {
          reply(id, { protocolVersion: "0.1", agent: "codeagent", capabilities: { streaming: true } });
        } else if (msg.method === "agent/run") {
          const task = String(msg.params?.task ?? "");
          const model = (msg.params?.model as string | undefined) ?? "gpt-5.6-luna";
          controller = new AbortController();
          const agent = new Agent({
            repoRoot: String(msg.params?.repoRoot ?? repoRoot),
            model,
            maxIterations: Number(msg.params?.maxIterations ?? 30),
            permissions: new PermissionManager({ autoApprove: (msg.params?.autoApprove as boolean | undefined) ?? false }),
            verbose: false,
            onEvent: (e) => {
              if ("respond" in e) return;
              process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "agent/event", params: e }) + "\n");
            },
          });
          agent.run(task, { signal: controller.signal }).then(
            (r) => reply(id, { finalMessage: r.finalMessage, stopReason: r.stopReason ?? "ok" }),
            (e: unknown) => fail(id, e instanceof Error ? e.message : String(e)),
          );
        } else if (msg.method === "agent/cancel") {
          controller?.abort();
          reply(id, { cancelled: true });
        } else {
          fail(id, `Unknown method: ${msg.method ?? "(missing)"}`);
        }
      } catch (e) {
        fail(id, e instanceof Error ? e.message : String(e));
      }
    }
  }
}
