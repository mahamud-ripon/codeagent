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
      "Read a repo-relative text file. ALWAYS read a file before editing it. Never guess contents. Text only: binary, image, and media files are rejected — you cannot view them.",
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
    name: "view_file",
    description:
      "View a file with line numbers and optional start_line / end_line slicing. Preferred over read_file for large files. Text only: binary, image, and media files are rejected — you cannot view them.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Repository-relative file path." },
        start_line: { type: "integer", description: "Optional 1-indexed starting line number." },
        end_line: { type: "integer", description: "Optional 1-indexed ending line number." },
      },
      required: ["path"],
    },
  },
  {
    type: "function",
    name: "view_symbol_outline",
    description:
      "Extract a structural outline of symbols (classes, interfaces, methods, exported functions) from a code file with line numbers. Highly recommended for understanding large files without reading full contents.",
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
    name: "run_subagent",
    description:
      "Spawn a focused, read-only subagent to explore codebases or design architectural plans without polluting the primary conversation history. Supports subagent_type: 'explore' (fast code search and findings) or 'plan' (software architecture and implementation planning).",
    parameters: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "Clear, specific research question, exploration goal, or planning task for the subagent.",
        },
        subagent_type: {
          type: "string",
          enum: ["explore", "plan"],
          description: "Subagent persona: 'explore' for search and code investigation (default), 'plan' for architectural planning.",
        },
      },
      required: ["task"],
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
  {
    type: "function",
    name: "todo_write",
    description:
      "Update the todo list for the current session. To be used proactively and often to track progress and pending tasks. Make sure that at least one task is in_progress at all times. Always provide both content (imperative) and activeForm (present continuous) for each task.",
    parameters: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Optional unique task identifier." },
              content: {
                type: "string",
                description: "The imperative form describing what needs to be done (e.g., 'Run tests', 'Build the project').",
              },
              status: {
                type: "string",
                enum: ["pending", "in_progress", "completed"],
                description: "The current state of the task (pending, in_progress, completed).",
              },
              activeForm: {
                type: "string",
                description: "The present continuous form shown during execution (e.g., 'Running tests', 'Building the project').",
              },
            },
            required: ["content", "status", "activeForm"],
          },
          description: "The updated todo list.",
        },
      },
      required: ["todos"],
    },
  },
  {
    type: "function",
    name: "enter_plan_mode",
    description:
      "Enter Plan Mode for non-trivial tasks or ambiguous architectures. Locks file mutations so you can safely explore and formulate a plan before writing code.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    type: "function",
    name: "exit_plan_mode",
    description:
      "Exit Plan Mode once your architecture plan is ready. Unlocks file editing and implementation tools.",
    parameters: {
      type: "object",
      properties: {
        plan_summary: {
          type: "string",
          description: "Summary of the agreed implementation plan.",
        },
      },
      required: [],
    },
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
