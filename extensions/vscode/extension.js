/**
 * CodeAgent VS Code Extension Host (HL-5)
 * Communicates with CodeAgent via the Agent Client Protocol (ACP) over stdio (`codeagent --acp`).
 *
 * Features:
 * - Interactive Sidebar Webview Chat with live markdown streaming and tool execution badges
 * - Quick task input via Ctrl+Alt+A / Cmd+Alt+A
 * - Editor context menu actions (Explain Code, Fix Code, Refactor, Generate Tests)
 * - Persistent Status Bar indicator
 * - Zero external bundled dependencies (uses VS Code API and Node.js built-ins)
 */

const { spawn } = require("node:child_process");
const vscode = require("vscode");

let proc = null;
let nextId = 1;
const pending = new Map();
let buffer = "";
let outputChannel = null;
let chatViewProvider = null;
let statusBarItem = null;
let isRunning = false;

function getCliCommand() {
  const config = vscode.workspace.getConfiguration("codeagent");
  return config.get("cliPath") || "codeagent";
}

function shouldAutoApprove() {
  const config = vscode.workspace.getConfiguration("codeagent");
  return config.get("autoApprove", true);
}

function getModel() {
  const config = vscode.workspace.getConfiguration("codeagent");
  const model = config.get("model");
  return (typeof model === "string" && model.trim()) ? model.trim() : undefined;
}

function send(msg) {
  if (!proc) throw new Error("CodeAgent bridge is not running.");
  proc.stdin.write(`${JSON.stringify(msg)}\n`);
}

function updateStatus(running, taskName = "") {
  isRunning = running;
  if (!statusBarItem) return;
  if (running) {
    statusBarItem.text = `$(sync~spin) CodeAgent: Running...`;
    statusBarItem.tooltip = `Running: ${taskName} (click to cancel)`;
    statusBarItem.command = "codeagent.cancelTask";
  } else {
    statusBarItem.text = `$(sparkle) CodeAgent`;
    statusBarItem.tooltip = "CodeAgent: Click to open chat";
    statusBarItem.command = "codeagent.openChat";
  }
}

function handleLine(line) {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }

  if (msg.method === "agent/event") {
    const e = msg.params || {};
    if (chatViewProvider) {
      chatViewProvider.handleAgentEvent(e);
    }

    if (outputChannel) {
      if (e.type === "text_delta") {
        outputChannel.append(e.text);
      } else if (e.type === "tool_start") {
        outputChannel.appendLine(`\n[tool] ${e.name} ${JSON.stringify(e.args || {})}`);
      } else if (e.type === "usage") {
        const cost = typeof e.costUsd === "number" ? ` $${e.costUsd.toFixed(4)}` : "";
        outputChannel.appendLine(`\n[usage] ${e.input} in / ${e.output} out${cost}`);
      } else if (e.type === "error") {
        outputChannel.appendLine(`\n[error] ${e.message}`);
        vscode.window.showErrorMessage(`CodeAgent: ${e.message}`);
      }
    }
    return;
  }

  if (msg.id !== undefined && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) {
      reject(new Error(msg.error.message || "ACP error"));
    } else {
      resolve(msg.result);
    }
  }
}

function ensureBridge() {
  if (proc) return Promise.resolve();
  return new Promise((resolve, reject) => {
    outputChannel = outputChannel || vscode.window.createOutputChannel("CodeAgent");
    const cli = getCliCommand();
    const args = ["--acp"];
    if (shouldAutoApprove()) {
      args.push("--auto-approve");
    }

    const isWin = process.platform === "win32";
    proc = spawn(cli, args, {
      stdio: ["pipe", "pipe", "inherit"],
      shell: isWin,
      windowsHide: true,
    });

    proc.on("error", (e) => {
      proc = null;
      updateStatus(false);
      reject(new Error(`Could not start '${cli} --acp' (is the CLI installed on PATH?): ${e.message}`));
    });

    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        try {
          handleLine(line);
        } catch {
          // preserve bridge lifecycle
        }
      }
    });

    proc.on("exit", () => {
      proc = null;
      updateStatus(false);
      for (const { reject: r } of pending.values()) {
        r(new Error("CodeAgent bridge process exited."));
      }
      pending.clear();
    });

    const id = nextId++;
    pending.set(id, { resolve, reject });
    send({ jsonrpc: "2.0", id, method: "initialize", params: {} });
  });
}

async function executeTask(taskPrompt, repoPath) {
  const folders = vscode.workspace.workspaceFolders || [];
  const repoRoot = repoPath || (folders[0] ? folders[0].uri.fsPath : undefined);

  updateStatus(true, taskPrompt.slice(0, 30));
  if (chatViewProvider) {
    chatViewProvider.startNewTask(taskPrompt);
  }

  try {
    await ensureBridge();
    const id = nextId++;
    const runParams = {
      task: taskPrompt,
      repoRoot,
      autoApprove: shouldAutoApprove(),
    };
    const model = getModel();
    if (model) {
      runParams.model = model;
    }
    const result = await new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      send({
        jsonrpc: "2.0",
        id,
        method: "agent/run",
        params: runParams,
      });
    });

    if (chatViewProvider) {
      chatViewProvider.taskCompleted(result);
    }
    updateStatus(false);
    return result;
  } catch (err) {
    updateStatus(false);
    if (chatViewProvider) {
      chatViewProvider.taskFailed(err);
    }
    throw err;
  }
}

class CodeAgentChatViewProvider {
  constructor(extensionUri) {
    this._extensionUri = extensionUri;
    this._view = null;
  }

  resolveWebviewView(webviewView) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (data) => {
      switch (data.type) {
        case "runTask":
          if (data.prompt && data.prompt.trim()) {
            try {
              await executeTask(data.prompt.trim());
            } catch (e) {
              vscode.window.showErrorMessage(`CodeAgent: ${e.message}`);
            }
          }
          break;
        case "cancelTask":
          vscode.commands.executeCommand("codeagent.cancelTask");
          break;
        case "clearChat":
          if (this._view) {
            this._view.webview.postMessage({ type: "clear" });
          }
          break;
      }
    });
  }

  startNewTask(prompt) {
    if (this._view) {
      this._view.show?.(true);
      this._view.webview.postMessage({ type: "userMessage", text: prompt });
      this._view.webview.postMessage({ type: "agentStart" });
    }
  }

  handleAgentEvent(event) {
    if (!this._view) return;
    if (event.type === "text_delta") {
      this._view.webview.postMessage({ type: "textDelta", text: event.text });
    } else if (event.type === "tool_start") {
      this._view.webview.postMessage({ type: "toolStart", name: event.name, args: event.args });
    } else if (event.type === "usage") {
      this._view.webview.postMessage({ type: "usage", input: event.input, output: event.output, costUsd: event.costUsd });
    } else if (event.type === "error") {
      this._view.webview.postMessage({ type: "error", message: event.message });
    }
  }

  taskCompleted(result) {
    if (this._view) {
      this._view.webview.postMessage({ type: "agentDone", result });
    }
  }

  taskFailed(err) {
    if (this._view) {
      this._view.webview.postMessage({ type: "agentError", message: err.message });
    }
  }

  _getHtmlForWebview() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>CodeAgent Assistant</title>
  <style>
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background-color: var(--vscode-editor-background);
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      height: 100vh;
      overflow: hidden;
    }
    #header {
      padding: 10px 12px;
      border-bottom: 1px solid var(--vscode-panel-border);
      display: flex;
      justify-content: space-between;
      align-items: center;
      background: var(--vscode-sideBar-background);
    }
    #header h3 {
      margin: 0;
      font-size: 13px;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    #messages {
      flex: 1;
      overflow-y: auto;
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .msg {
      padding: 8px 12px;
      border-radius: 6px;
      line-height: 1.5;
      font-size: 12.5px;
      max-width: 95%;
      word-wrap: break-word;
    }
    .user {
      align-self: flex-end;
      background-color: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      white-space: pre-wrap;
    }
    .agent {
      align-self: flex-start;
      background-color: var(--vscode-editor-inactiveSelectionBackground);
      color: var(--vscode-editor-foreground);
      border: 1px solid var(--vscode-panel-border);
    }
    .msg.agent.thinking {
      color: var(--vscode-descriptionForeground);
      font-style: italic;
      font-size: 12px;
      padding: 6px 10px;
    }
    .thinking-dots::after {
      content: "...";
      animation: thinkingAnim 1.6s steps(4, end) infinite;
    }
    @keyframes thinkingAnim {
      0%, 20% { content: ""; }
      40% { content: "."; }
      60% { content: ".."; }
      80%, 100% { content: "..."; }
    }
    .tool-badge {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 3px 8px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      border-radius: 4px;
      font-size: 11px;
      margin: 2px 0;
      font-family: var(--vscode-editor-font-family, monospace);
      max-width: 90%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .code-block {
      background: var(--vscode-textCodeBlock-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      padding: 8px 10px;
      margin: 8px 0;
      overflow-x: auto;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11.5px;
      white-space: pre;
    }
    .inline-code {
      background: var(--vscode-textCodeBlock-background);
      border-radius: 3px;
      padding: 1px 4px;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11.5px;
    }
    .md-h2, .md-h3, .md-h4 {
      margin: 8px 0 4px 0;
      font-weight: 600;
    }
    .md-h2 { font-size: 14px; }
    .md-h3 { font-size: 13px; }
    .md-h4 { font-size: 12.5px; }
    .md-ul {
      margin: 4px 0;
      padding-left: 18px;
    }
    .md-li {
      margin: 2px 0;
    }
    .spacer {
      height: 8px;
    }
    #input-container {
      padding: 10px 12px;
      border-top: 1px solid var(--vscode-panel-border);
      background: var(--vscode-sideBar-background);
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    textarea {
      width: 100%;
      height: 60px;
      box-sizing: border-box;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border);
      border-radius: 4px;
      padding: 6px 8px;
      font-family: inherit;
      font-size: 12px;
      resize: none;
      outline: none;
    }
    textarea:focus {
      border-color: var(--vscode-focusBorder);
    }
    .buttons {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    button {
      padding: 5px 12px;
      border: none;
      border-radius: 3px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      cursor: pointer;
      font-size: 12px;
    }
    button:hover {
      background: var(--vscode-button-hoverBackground);
    }
    button.secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    #stats {
      font-size: 10.5px;
      color: var(--vscode-descriptionForeground);
      text-align: right;
    }
  </style>
</head>
<body>
  <div id="header">
    <h3>✨ CodeAgent</h3>
    <button class="secondary" id="clearBtn" title="Clear Chat">Clear</button>
  </div>
  <div id="messages">
    <div class="msg agent">Hello! I am CodeAgent. Ask me to fix a bug, refactor code, write tests, or build new features.</div>
  </div>
  <div id="input-container">
    <textarea id="promptInput" placeholder="Ask CodeAgent (Ctrl+Enter to send)..."></textarea>
    <div class="buttons">
      <span id="stats">Ready</span>
      <div style="display: flex; gap: 6px;">
        <button id="cancelBtn" class="secondary" style="display: none;">Cancel</button>
        <button id="sendBtn">Send</button>
      </div>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const messagesDiv = document.getElementById("messages");
    const input = document.getElementById("promptInput");
    const sendBtn = document.getElementById("sendBtn");
    const cancelBtn = document.getElementById("cancelBtn");
    const clearBtn = document.getElementById("clearBtn");
    const statsSpan = document.getElementById("stats");

    let currentAgentMsg = null;

    function escapeHtml(str) {
      return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
    }

    function renderMarkdown(el, text) {
      if (!text) {
        el.innerHTML = "";
        return;
      }
      let safe = escapeHtml(text);
      safe = safe.replace(/\`\`\`([\\s\\S]*?)\`\`\`/g, function(_, code) {
        return '<pre class="code-block"><code>' + code.trim() + '</code></pre>';
      });
      safe = safe.replace(/\`([^\`]+)\`/g, '<code class="inline-code">$1</code>');
      safe = safe.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');
      safe = safe.replace(/\\*([^*]+)\\*/g, '<em>$1</em>');
      safe = safe.replace(/^### ([^\\n]+)/gm, '<h4 class="md-h4">$1</h4>');
      safe = safe.replace(/^## ([^\\n]+)/gm, '<h3 class="md-h3">$1</h3>');
      safe = safe.replace(/^# ([^\\n]+)/gm, '<h2 class="md-h2">$1</h2>');
      safe = safe.replace(/^[*-] ([^\\n]+)/gm, '<li class="md-li">$1</li>');
      safe = safe.replace(/(<li class="md-li">[^]*?<\\/li>)/g, '<ul class="md-ul">$1</ul>');
      safe = safe.replace(/\\n\\n+/g, '<div class="spacer"></div>');
      safe = safe.replace(/\\n/g, '<br>');
      el.innerHTML = safe;
    }

    function scrollToBottom() {
      messagesDiv.scrollTop = messagesDiv.scrollHeight;
    }

    sendBtn.addEventListener("click", () => {
      const text = input.value.trim();
      if (!text) return;
      input.value = "";
      currentAgentMsg = null;
      vscode.postMessage({ type: "runTask", prompt: text });
    });

    cancelBtn.addEventListener("click", () => {
      vscode.postMessage({ type: "cancelTask" });
    });

    clearBtn.addEventListener("click", () => {
      messagesDiv.innerHTML = '<div class="msg agent">Hello! I am CodeAgent. Ask me to fix a bug, refactor code, write tests, or build new features.</div>';
      statsSpan.textContent = "Ready";
      currentAgentMsg = null;
    });

    input.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        sendBtn.click();
      }
    });

    window.addEventListener("message", (e) => {
      const msg = e.data;
      switch (msg.type) {
        case "userMessage": {
          const div = document.createElement("div");
          div.className = "msg user";
          div.textContent = msg.text;
          messagesDiv.appendChild(div);
          cancelBtn.style.display = "inline-block";
          sendBtn.disabled = true;
          statsSpan.textContent = "Running task...";
          scrollToBottom();
          break;
        }
        case "agentStart": {
          currentAgentMsg = document.createElement("div");
          currentAgentMsg.className = "msg agent thinking";
          currentAgentMsg.innerHTML = '<span class="thinking-text">Thinking<span class="thinking-dots"></span></span>';
          messagesDiv.appendChild(currentAgentMsg);
          scrollToBottom();
          break;
        }
        case "textDelta": {
          if (!currentAgentMsg) {
            currentAgentMsg = document.createElement("div");
            currentAgentMsg.className = "msg agent";
            messagesDiv.appendChild(currentAgentMsg);
          }
          if (currentAgentMsg.classList.contains("thinking")) {
            currentAgentMsg.classList.remove("thinking");
            currentAgentMsg.rawText = "";
          }
          currentAgentMsg.rawText = (currentAgentMsg.rawText || "") + msg.text;
          renderMarkdown(currentAgentMsg, currentAgentMsg.rawText);
          scrollToBottom();
          break;
        }
        case "toolStart": {
          if (currentAgentMsg && currentAgentMsg.classList.contains("thinking")) {
            currentAgentMsg.remove();
            currentAgentMsg = null;
          }
          const badge = document.createElement("div");
          badge.className = "tool-badge";
          let extra = "";
          if (msg.args && typeof msg.args === "object") {
            const vals = Object.values(msg.args).filter(v => typeof v === "string" && v.length < 80);
            if (vals.length > 0) extra = " · " + vals[0];
          }
          badge.textContent = "⚙ " + msg.name + extra;
          badge.title = JSON.stringify(msg.args || {}, null, 2);
          messagesDiv.appendChild(badge);
          scrollToBottom();
          break;
        }
        case "usage": {
          const cost = typeof msg.costUsd === "number" ? (" · $" + msg.costUsd.toFixed(4)) : "";
          statsSpan.textContent = msg.input + " in / " + msg.output + " out" + cost;
          break;
        }
        case "agentDone": {
          cancelBtn.style.display = "none";
          sendBtn.disabled = false;
          statsSpan.textContent = "Finished: " + (msg.result?.stopReason || "ok");
          const finalMsg = msg.result?.finalMessage;
          if (currentAgentMsg) {
            if (currentAgentMsg.classList.contains("thinking")) {
              currentAgentMsg.classList.remove("thinking");
              if (finalMsg) {
                renderMarkdown(currentAgentMsg, finalMsg);
              } else {
                currentAgentMsg.remove();
              }
            } else if (finalMsg) {
              renderMarkdown(currentAgentMsg, finalMsg);
            }
          } else if (finalMsg) {
            const div = document.createElement("div");
            div.className = "msg agent";
            renderMarkdown(div, finalMsg);
            messagesDiv.appendChild(div);
          }
          currentAgentMsg = null;
          scrollToBottom();
          break;
        }
        case "agentError": {
          cancelBtn.style.display = "none";
          sendBtn.disabled = false;
          statsSpan.textContent = "Error occurred";
          if (currentAgentMsg && currentAgentMsg.classList.contains("thinking")) {
            currentAgentMsg.remove();
          }
          const errDiv = document.createElement("div");
          errDiv.className = "msg agent";
          errDiv.style.color = "var(--vscode-errorForeground)";
          errDiv.textContent = "Error: " + msg.message;
          messagesDiv.appendChild(errDiv);
          currentAgentMsg = null;
          scrollToBottom();
          break;
        }
      }
    });
  </script>
</body>
</html>`;
  }
}

function getSelectedCodeContext() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return null;
  const selection = editor.selection;
  const selectedText = editor.document.getText(selection).trim();
  const filePath = vscode.workspace.asRelativePath(editor.document.uri);
  const language = editor.document.languageId;
  return { selectedText, filePath, language };
}

function activate(context) {
  // 1. Register Sidebar Webview View
  chatViewProvider = new CodeAgentChatViewProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("codeagent.chatView", chatViewProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  // 2. Status Bar Item
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  updateStatus(false);
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // 3. Open Chat Command
  const openChat = vscode.commands.registerCommand("codeagent.openChat", () => {
    vscode.commands.executeCommand("workbench.view.extension.codeagent-sidebar");
  });

  // 4. Run Task Command (Input Box)
  const runTask = vscode.commands.registerCommand("codeagent.runTask", async () => {
    const task = await vscode.window.showInputBox({
      prompt: "Describe task for CodeAgent",
      placeHolder: "Fix failing test, refactor method, implement new endpoint...",
    });
    if (!task || !task.trim()) return;
    try {
      await executeTask(task.trim());
    } catch (e) {
      vscode.window.showErrorMessage(`CodeAgent: ${e.message}`);
    }
  });

  // 5. Cancel Task Command
  const cancelTask = vscode.commands.registerCommand("codeagent.cancelTask", async () => {
    if (!proc) return;
    const id = nextId++;
    await new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      send({ jsonrpc: "2.0", id, method: "agent/cancel", params: {} });
    }).catch(() => {});
    updateStatus(false);
  });

  // 6. Editor Context Actions
  const explainCode = vscode.commands.registerCommand("codeagent.explainCode", async () => {
    const ctx = getSelectedCodeContext();
    if (!ctx || !ctx.selectedText) return;
    const prompt = `Explain the following code from ${ctx.filePath}:\n\n\`\`\`${ctx.language}\n${ctx.selectedText}\n\`\`\``;
    vscode.commands.executeCommand("codeagent.openChat");
    await executeTask(prompt);
  });

  const fixCode = vscode.commands.registerCommand("codeagent.fixCode", async () => {
    const ctx = getSelectedCodeContext();
    if (!ctx || !ctx.selectedText) return;
    const prompt = `Diagnose and fix any bugs, errors, or performance issues in the following code from ${ctx.filePath}:\n\n\`\`\`${ctx.language}\n${ctx.selectedText}\n\`\`\``;
    vscode.commands.executeCommand("codeagent.openChat");
    await executeTask(prompt);
  });

  const refactorCode = vscode.commands.registerCommand("codeagent.refactorCode", async () => {
    const ctx = getSelectedCodeContext();
    if (!ctx || !ctx.selectedText) return;
    const prompt = `Refactor and clean up the following code from ${ctx.filePath} for readability, maintainability, and best practices:\n\n\`\`\`${ctx.language}\n${ctx.selectedText}\n\`\`\``;
    vscode.commands.executeCommand("codeagent.openChat");
    await executeTask(prompt);
  });

  const generateTests = vscode.commands.registerCommand("codeagent.generateTests", async () => {
    const ctx = getSelectedCodeContext();
    if (!ctx || !ctx.selectedText) return;
    const prompt = `Write unit tests covering happy paths, error handling, and edge cases for the following code from ${ctx.filePath}:\n\n\`\`\`${ctx.language}\n${ctx.selectedText}\n\`\`\``;
    vscode.commands.executeCommand("codeagent.openChat");
    await executeTask(prompt);
  });

  context.subscriptions.push(openChat, runTask, cancelTask, explainCode, fixCode, refactorCode, generateTests, {
    dispose: () => {
      if (proc) proc.kill();
      proc = null;
    },
  });
}

function deactivate() {
  if (proc) proc.kill();
  proc = null;
  updateStatus(false);
}

module.exports = { activate, deactivate };
