import readline from "node:readline";
import { RuntimeClient, type RunHandle } from "../runtime/client.js";
import { loadGlobalEnv } from "../cli/config.js";
/** CodeAgent's versioned JSON-RPC bridge to the local supervisor. */
export async function startAcpServer(
  repoRoot = process.cwd(),
  options: { autoApprove?: boolean } = {},
): Promise<void> {
  loadGlobalEnv();
  const client = new RuntimeClient();
  await client.ensure();
  let initialized = false;
  let active: RunHandle | undefined;
  let sessionId: string | undefined;
  const send = (message: unknown) =>
    process.stdout.write(JSON.stringify(message) + "\n");
  const rl = readline.createInterface({ input: process.stdin });
  async function stream(handle: RunHandle): Promise<void> {
    for await (const event of handle.events()) {
      if (active !== handle) return;
      if (event.type === "approval_request" || event.type === "input_request") {
        const state = await client.request<{ pending: Array<{ id: string }> }>(
          "inspect",
          { sessionId: handle.sessionId },
        );
        if (!state.pending.some((p) => p.id === event.data.id)) continue;
      }
      send({ jsonrpc: "2.0", method: "agent/event", params: event });
    }
  }
  rl.on("line", (line) => {
    void (async () => {
      let id: unknown;
      try {
        const msg = JSON.parse(line) as {
          id: unknown;
          method: string;
          params?: Record<string, unknown>;
        };
        id = msg.id;
        const p = msg.params ?? {};
        let result: unknown;
        if (msg.method === "initialize") {
          if (p.protocolVersion !== undefined && p.protocolVersion !== "1.0")
            throw new Error("Expected CodeAgent protocol 1.0");
          initialized = true;
          result = {
            protocolVersion: "1.0",
            agent: "codeagent",
            capabilities: {
              streaming: true,
              sessions: true,
              approvals: true,
              detach: true,
              tasks: true,
              workers: true,
            },
          };
        } else {
          if (!initialized) throw new Error("Initialize protocol 1.0 first");
          if (msg.method === "agent/run") {
            sessionId =
              typeof p.sessionId === "string" ? p.sessionId : sessionId;
            if (!sessionId)
              sessionId = (
                await client.create(String(p.repoRoot ?? repoRoot), {
                  model: p.model as string | undefined,
                  provider: p.provider as "openai" | undefined,
                  baseURL: p.baseURL as string | undefined,
                  maxIterations: Number(p.maxIterations ?? 30),
                  autoApprove:
                    (p.autoApprove as boolean | undefined) ??
                    options.autoApprove ??
                    false,
                })
              ).id;
            active = await client.submit(sessionId, String(p.task ?? ""));
            const current = active;
            void stream(current).catch((error) =>
              send({
                jsonrpc: "2.0",
                method: "agent/error",
                params: { message: String(error) },
              }),
            );
            result = await current.result();
          } else if (msg.method === "agent/attach") {
            active = await client.attach(String(p.sessionId));
            sessionId = active.sessionId;
            void stream(active).catch(() => {});
            result = { sessionId, runId: active.runId };
          } else if (msg.method === "agent/cancel") {
            if (!active) throw new Error("No active run");
            result = await active.cancel();
          } else if (msg.method === "agent/steer") {
            if (!active) throw new Error("No active run");
            result = await active.steer(String(p.text));
          } else if (msg.method === "agent/answer") {
            if (!active) throw new Error("No active run");
            result = await active.answer(
              String(p.id),
              p.answer as boolean | string,
            );
          } else if (msg.method === "agent/inspect") {
            result = await client.request("inspect", {
              sessionId: p.sessionId ?? sessionId,
            });
          } else if (msg.method === "agent/new") {
            sessionId = undefined;
            active = undefined;
            result = { ok: true };
          } else throw new Error("Unknown method");
        }
        send({ jsonrpc: "2.0", id, result });
      } catch (e) {
        send({
          jsonrpc: "2.0",
          id,
          error: {
            code: -32000,
            message: e instanceof Error ? e.message : String(e),
          },
        });
      }
    })();
  });
  await new Promise<void>((resolve) => rl.once("close", resolve));
  active = undefined;
}
