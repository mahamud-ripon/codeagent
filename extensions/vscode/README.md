# CodeAgent VS Code bridge (HL-5)

Drives the `codeagent --acp` stdio bridge from VS Code. No bundled
dependencies — only the `vscode` host API and Node built-ins.

## Install

1. Put the CLI on PATH: `npm i -g codeagent` (or `npm run build` + link `dist/`).
2. Copy this folder into an extension host (or `npx -y @vscode/vsce package`
   via `npm run vscode:package`) and install the `.vsix`.
3. Run **CodeAgent: Run Task** from the command palette.

## Protocol

Newline-delimited JSON-RPC, same as `src/integrations/acp.ts`:

- `initialize` → `{ protocolVersion, agent, capabilities }`
- `agent/run` (`task`, `repoRoot`) → streams `agent/event` notifications
  (`text_delta`, `tool_start`, `usage`, `error`) to the CodeAgent output
  channel, resolves `{ finalMessage, stopReason }`
- `agent/cancel` → aborts the running task

## Limits

- One session per window; `codeagent.cancelTask` aborts it.
- Permission prompts stay fail-closed headless: pre-approve via workspace
  `.codeagent/settings.json` allow rules or run unattended with the bypass
  flag configured for the CLI.
