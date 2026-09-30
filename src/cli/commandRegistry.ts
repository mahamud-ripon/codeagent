/**
 * F-13 split (1/3): slash-command registry.
 * Pure metadata extracted from repl.ts so commands are testable without the god file.
 * repl.ts remains the runtime; new UI code should import from here.
 */

export interface CommandMeta {
  name: string;
  description: string;
  usage?: string;
}

export const SLASH_COMMANDS: CommandMeta[] = [
  { name: "help", description: "Show help" },
  { name: "status", description: "Show model, provider, usage, modes" },
  { name: "sessions", description: "List saved sessions" },
  { name: "session", description: "Session new/resume/save/delete", usage: "/session <new|resume|save|delete> [id]" },
  { name: "resume", description: "Resume a session" },
  { name: "new", description: "Start a new session" },
  { name: "undo", description: "Revert last code changes (code-only)" },
  { name: "rewind", description: "Restore code/conversation/both to a turn", usage: "/rewind [n] [code|conversation|both]" },
  { name: "export", description: "Export session to Markdown", usage: "/export [file]" },
  { name: "checkpoints", description: "List turns + checkpoints" },
  { name: "repo", description: "Show workspace root" },
  { name: "model", description: "Show/switch model" },
  { name: "provider", description: "Show/switch provider" },
  { name: "endpoint", description: "Set OpenAI-compat endpoint" },
  { name: "key", description: "Save API key globally" },
  { name: "sandbox", description: "Switch sandbox runner", usage: "/sandbox [docker|local]" },
  { name: "mcp", description: "List MCP servers/tools" },
  { name: "iterations", description: "Show/set max iterations" },
  { name: "diff", description: "Show current git diff" },
  { name: "plan", description: "Enter plan mode" },
  { name: "todos", description: "Toggle todo panel" },
  { name: "worktree", description: "Manage git worktrees" },
  { name: "compact", description: "Compact context", usage: "/compact [focus]" },
  { name: "cost", description: "Show session tokens/cost" },
  { name: "init", description: "Generate AGENTS.md memory file" },
  { name: "mode", description: "Show/switch permission mode" },
  { name: "auto", description: "Enable bypass approvals" },
  { name: "manual", description: "Back to ask mode" },
  { name: "clear", description: "Clear screen / session" },
  { name: "exit", description: "Exit REPL" },
];

export function findCommand(name: string): CommandMeta | undefined {
  return SLASH_COMMANDS.find((c) => c.name === name.toLowerCase());
}

export function commandNames(): string[] {
  return SLASH_COMMANDS.map((c) => c.name);
}
