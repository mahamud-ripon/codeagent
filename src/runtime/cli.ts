import readline from "node:readline/promises";
import fs from "node:fs";
import { RuntimeClient, type RunHandle } from "./client.js";
import type { CliArgs } from "../index.js";
import type { RuntimeEvent, SessionSnapshot } from "./contracts.js";
import { exitCodeForStopReason } from "../cli/headless.js";
import { loadGlobalEnv } from "../cli/config.js";

export async function runtimeCli(
  args: CliArgs,
  raw: string[],
): Promise<boolean> {
  if (args.acp || args.mcpArgs || raw[0] === "plugin") return false;
  loadGlobalEnv();
  const client = new RuntimeClient();
  await client.ensure();
  const after = (flag: string) => {
    const i = raw.indexOf(flag);
    return i >= 0 ? raw[i + 1] : undefined;
  };
  const output = args.outputFormat ?? "text";
  let rl: ReturnType<typeof readline.createInterface> | undefined;
  const ask = async (prompt: string) => {
    if (!process.stdin.isTTY)
      throw new Error("Input pending. Attach an interactive client.");
    rl ??= readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    return rl.question(prompt);
  };
  const show = async (handle: RunHandle): Promise<void> => {
    console.error(
      `Session ${handle.sessionId} · attach with codeagent --attach ${handle.sessionId}`,
    );
    const interrupt = () => {
      void handle.cancel().catch(() => {});
    };
    process.once("SIGINT", interrupt);
    try {
      for await (const e of handle.events()) {
        if (output === "stream-json") console.log(JSON.stringify(e));
        if (e.type === "approval_request" || e.type === "input_request") {
          if (!process.stdin.isTTY) {
            console.error(
              `Waiting for ${e.type === "approval_request" ? "approval" : "input"}. Session remains available for attachment.`,
            );
            process.exitCode = 4;
            return;
          }
          const current = await client.request<{
            pending: Array<{ id: string }>;
          }>("inspect", { sessionId: handle.sessionId });
          if (!current.pending.some((p) => p.id === e.data.id)) continue;
          const answer = await ask(
            `${String(e.data.prompt)}${e.type === "approval_request" ? " [y/N] " : "\n> "}`,
          );
          await handle.answer(
            String(e.data.id),
            e.type === "approval_request"
              ? /^y(?:es)?$/i.test(answer.trim())
              : answer,
          );
        }
        if (output === "text" && e.type === "text_delta")
          process.stdout.write(String(e.data.text ?? ""));
        if (
          output === "text" &&
          [
            "tool_intent",
            "worker_started",
            "worker_finished",
            "worker_integrated",
            "verification",
            "tasks",
          ].includes(e.type)
        )
          console.log(
            `\n[${e.agentId}] ${e.type}: ${JSON.stringify(e.data).slice(0, 500)}`,
          );
        if (e.type === "done" && e.agentId === "coordinator") {
          if (output === "json") console.log(JSON.stringify(e.data));
          else if (output === "text")
            console.log(
              `\n${String(e.data.finalMessage ?? "")}\nStatus: ${String(e.data.status)}`,
            );
          process.exitCode = exitCodeForStopReason(String(e.data.stopReason));
          return;
        }
      }
    } finally {
      process.off("SIGINT", interrupt);
    }
  };
  try {
    if (args.showSessions || raw[0] === "sessions") {
      const sessions = await client.request<SessionSnapshot[]>("list");
      console.log(
        JSON.stringify(
          sessions.map(({ id, repoRoot, status, runId }) => ({
            id,
            repoRoot,
            status,
            runId,
          })),
          null,
          2,
        ),
      );
      return true;
    }
    if (["cancel", "pause", "undo"].includes(raw[0])) {
      console.log(
        JSON.stringify(await client.request(raw[0], { sessionId: raw[1] })),
      );
      return true;
    }
    if (raw[0] === "steer") {
      console.log(
        JSON.stringify(
          await client.request("steer", {
            sessionId: raw[1],
            text: raw.slice(2).join(" "),
          }),
        ),
      );
      return true;
    }
    if (raw[0] === "inspect") {
      console.log(
        JSON.stringify(
          await client.request("inspect", { sessionId: raw[1] }),
          null,
          2,
        ),
      );
      return true;
    }
    if (raw[0] === "fork") {
      console.log(
        JSON.stringify(await client.request("fork", { sessionId: raw[1] })),
      );
      return true;
    }
    if (raw[0] === "import-session") {
      console.log(
        JSON.stringify(await client.request("import", { file: raw[1] })),
      );
      return true;
    }
    const attach = after("--attach");
    if (attach) {
      await show(await client.attach(attach));
      return true;
    }
    const newSession = async () =>
      client.create(args.repo, {
        model: args.model,
        provider: args.provider,
        baseURL: args.baseURL,
        maxIterations: args.maxIterations,
        autoApprove: args.autoApprove,
        allowedTools: args.allowedTools,
        sandboxMode: args.sandbox,
      });
    let sessionId: string | undefined;
    if (args.resume) {
      const sessions = await client.request<SessionSnapshot[]>("list");
      sessionId =
        typeof args.resume === "string"
          ? args.resume
          : sessions.filter((s) => s.repoRoot === args.repo).at(-1)?.id;
      if (!sessionId) throw new Error("No session to resume");
    }
    let task = args.task.replace(/(?:^|\s)--detach(?:\s|$)/g, " ").trim();
    if (!task && !process.stdin.isTTY) task = fs.readFileSync(0, "utf8").trim();
    if (task) {
      sessionId ??= (await newSession()).id;
      const handle = await client.submit(sessionId, task);
      if (raw.includes("--detach"))
        console.log(JSON.stringify(handle.detach()));
      else await show(handle);
      return true;
    }
    console.log(
      "CodeAgent 1.0 · /new /status /tasks /agents /jobs /fork /detach /exit",
    );
    while (process.stdin.isTTY) {
      const line = (await ask("codeagent> ")).trim();
      if (!line) continue;
      if (line === "/exit" || line === "/detach") break;
      if (line === "/new") {
        sessionId = undefined;
        continue;
      }
      if (["/status", "/tasks", "/agents", "/jobs"].includes(line)) {
        if (!sessionId) {
          console.log("No active session");
          continue;
        }
        const s = await client.request<Record<string, unknown>>("inspect", {
          sessionId,
        });
        if (line === "/tasks") console.log(JSON.stringify(s.tasks, null, 2));
        else if (line === "/agents" || line === "/jobs") {
          const events = await client.request<RuntimeEvent[]>("events", {
            sessionId,
          });
          console.log(
            JSON.stringify(
              events
                .filter((e) =>
                  line === "/agents"
                    ? e.type.startsWith("worker_")
                    : e.type === "tool_result" && e.data.name === "run_command",
                )
                .map((e) => e.data),
              null,
              2,
            ),
          );
        } else console.log(JSON.stringify(s, null, 2));
        continue;
      }
      if (line === "/undo") {
        if (!sessionId) throw new Error("No session");
        console.log(await client.request("undo", { sessionId }));
        continue;
      }
      if (line === "/fork") {
        if (!sessionId) throw new Error("No session");
        sessionId = (
          await client.request<SessionSnapshot>("fork", { sessionId })
        ).id;
        continue;
      }
      sessionId ??= (await newSession()).id;
      await show(await client.submit(sessionId, line));
    }
    return true;
  } finally {
    rl?.close();
  }
}
