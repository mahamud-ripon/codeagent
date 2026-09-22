/**
 * OpenAI Responses API function-tool definitions.
 * Keep descriptions imperative and narrow: the model chooses tools
 * based on these strings, so each one should state WHEN to use it.
 */
export const tools = [
  {
    type: "function",
    name: "list_files",
    description:
      "List repository files. Use first to understand structure. Ignores .git, node_modules, dist, build artifacts.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative directory path. Defaults to '.'.",
        },
      },
      required: [],
    },
  },
  {
    type: "function",
    name: "read_file",
    description:
      "Read a repo-relative text file. ALWAYS read a file before editing it. Never guess contents.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Repository-relative file path." },
      },
      required: ["path"],
    },
  },
  {
    type: "function",
    name: "write_file",
    description:
      "Create a new file or fully replace one. Prefer edit_file for modifications to existing files.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
    },
  },
  {
    type: "function",
    name: "edit_file",
    description:
      "Replace exactly one occurrence of old_text with new_text in an existing file. Fails on zero or multiple matches.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_text: { type: "string" },
        new_text: { type: "string" },
      },
      required: ["path", "old_text", "new_text"],
    },
  },
  {
    type: "function",
    name: "search",
    description:
      "Search repo source with ripgrep. Use to locate symbols, routes, tests before reading files.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
      },
      required: ["query"],
    },
  },
  {
    type: "function",
    name: "run_command",
    description:
      "Run a shell command from the repo root (tests, build, lint, typecheck). Returns exit code + truncated output. Development-only: no sandbox.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string" },
      },
      required: ["command"],
    },
  },
  {
    type: "function",
    name: "git_status",
    description: "Show git working-tree status (short format).",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    type: "function",
    name: "git_diff",
    description:
      "Show current uncommitted git diff. ALWAYS inspect before finishing.",
    parameters: { type: "object", properties: {}, required: [] },
  },
] as const;

export type LlmToolName = (typeof tools)[number]["name"];

/**
 * Chat Completions variant of the same tool set
 * ({ type: "function", function: {...} } shape).
 * Lazily typed against the OpenAI namespace to avoid a hard
 * dependency from this module on the SDK client.
 */
export function toChatTools(): Array<{
  type: "function";
  function: { name: string; description?: string; parameters?: Record<string, unknown> };
}> {
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters as unknown as Record<string, unknown>,
    },
  }));
}
