/**
 * HL-5 VS Code bridge (extension host) for the CodeAgent ACP stdio bridge.
 * Spawns `codeagent --acp` and speaks the same newline-delimited JSON-RPC
 * as src/integrations/acp.ts: initialize / agent/run / agent/cancel, with
 * `agent/event` notifications streamed to the output channel.
 *
 * No bundled dependencies: only the `vscode` API (provided by the host)
 * and Node built-ins. Requires the `codeagent` CLI on PATH
 * (`npm i -g codeagent`).
 */
const { spawn } = require("node:child_process");

let proc = null;
let nextId = 1;
const pending = new Map();
let buffer = "";
let output = null;

function send(msg) {
  if (!proc) throw new Error("CodeAgent bridge is not running.");
  proc.stdin.write(`${JSON.stringify(msg)}\n`);
}

function handleLine(line, vscode) {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.method === "agent/event") {
    const e = msg.params || {};
    if (e.type === "text_delta") output.append(e.text);
    else if (e.type === "tool_start") output.appendLine(`\n[tool] ${e.name}`);
    else if (e.type === "usage") {
      const cost = typeof e.costUsd === "number" ? ` $${e.costUsd.toFixed(4)}` : "";
      output.appendLine(`\n[usage] ${e.input} in / ${e.output} out${cost}`);
    } else if (e.type === "error") {
      vscode.window.showErrorMessage(`CodeAgent: ${e.message}`);
    }
    return;
  }
  if (msg.id !== undefined && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message || "ACP error"));
    else resolve(msg.result);
  }
}

function ensureBridge(vscode) {
  if (proc) return Promise.resolve();
  return new Promise((resolve, reject) => {
    output = output || vscode.window.createOutputChannel("CodeAgent");
    proc = spawn("codeagent", ["--acp"], { stdio: ["pipe", "pipe", "inherit"] });
    proc.on("error", (e) => {
      proc = null;
      reject(new Error(`Could not start 'codeagent --acp' (is the CLI on PATH?): ${e.message}`));
    });
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        try {
          handleLine(line, vscode);
        } catch {
          // never let a display error kill the bridge
        }
      }
    });
    proc.on("exit", () => {
      proc = null;
      for (const { reject: r } of pending.values()) r(new Error("CodeAgent bridge exited."));
      pending.clear();
    });
    const id = nextId++;
    pending.set(id, { resolve, reject });
    send({ jsonrpc: "2.0", id, method: "initialize", params: {} });
  });
}

function activate(context) {
  const vscode = require("vscode");
  const run = vscode.commands.registerCommand("codeagent.runTask", async () => {
    const task = await vscode.window.showInputBox({ prompt: "CodeAgent task", placeHolder: "Fix the failing test…" });
    if (!task) return;
    output = output || vscode.window.createOutputChannel("CodeAgent");
    output.show(true);
    try {
      await ensureBridge(vscode);
      const folders = vscode.workspace.workspaceFolders || [];
      const id = nextId++;
      const result = await new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        send({
          jsonrpc: "2.0",
          id,
          method: "agent/run",
          params: {
            task,
            repoRoot: folders[0] ? folders[0].uri.fsPath : undefined,
          },
        });
      });
      output.appendLine(`\n[done] ${result && result.stopReason ? result.stopReason : "ok"}`);
    } catch (e) {
      vscode.window.showErrorMessage(`CodeAgent: ${e instanceof Error ? e.message : String(e)}`);
    }
  });
  const cancel = vscode.commands.registerCommand("codeagent.cancelTask", async () => {
    if (!proc) return;
    const id = nextId++;
    await new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      send({ jsonrpc: "2.0", id, method: "agent/cancel", params: {} });
    }).catch(() => {});
  });
  context.subscriptions.push(run, cancel, {
    dispose: () => {
      if (proc) proc.kill();
      proc = null;
    },
  });
}

function deactivate() {
  if (proc) proc.kill();
  proc = null;
}

module.exports = { activate, deactivate };
