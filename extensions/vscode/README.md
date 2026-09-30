# CodeAgent VS Code Extension (HL-5)

Official Visual Studio Code extension for **CodeAgent** — the autonomous coding agent.
Communicates directly with the `codeagent --acp` stdio bridge via the Agent Client Protocol (ACP).

---

## Features

* **✨ Interactive Sidebar Chat**: Chat with CodeAgent directly inside your VS Code activity bar. Watch thoughts and file modifications stream in real-time with tool badges.
* **⚡ Quick Task Execution**: Press `Ctrl+Alt+A` (`Cmd+Alt+A` on macOS) or run `CodeAgent: Run Task` to trigger a task from the input box.
* **🔍 Context Menu Actions**: Select any code in the editor, right click, and choose:
  * **CodeAgent: Explain Code**
  * **CodeAgent: Fix Selected Code**
  * **CodeAgent: Refactor Selected Code**
  * **CodeAgent: Generate Unit Tests**
* **📊 Status Bar Integration**: Interactive bottom status bar item shows current agent state, running task status, and token usage.
* **🛡️ Zero External Dependencies**: Runs entirely on the native VS Code API and Node.js built-ins.

---

## Prerequisites

Ensure the `codeagent` CLI is installed globally or available on your `PATH`:

```bash
npm install -g @mahamud-ripon/codeagent
```

*(You can also configure a custom CLI path in VS Code Settings: `codeagent.cliPath`.)*

---

## Installation

### Option 1: Install from `.vsix` (Direct)

From the project root:

```bash
code --install-extension extensions/vscode/codeagent-vscode-0.7.0.vsix
```

Or in VS Code:
1. Open the **Extensions** view (`Ctrl+Shift+X` / `Cmd+Shift+X`).
2. Click the `...` menu in the top right.
3. Select **Install from VSIX...**.
4. Choose `extensions/vscode/codeagent-vscode-0.7.0.vsix`.

### Option 2: Package from Source

```bash
cd extensions/vscode
npx -y @vscode/vsce package --no-yarn
```

---

## Configuration Settings

In your VS Code `settings.json`:

```json
{
  "codeagent.cliPath": "codeagent",
  "codeagent.autoApprove": true
}
```

* `codeagent.cliPath`: Custom path to your `codeagent` executable (default: `codeagent` on PATH).
* `codeagent.autoApprove`: Auto-approve tool operations (default: `true`).

---

## License

MIT © Mahamud Ripon
