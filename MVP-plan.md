I’d build the MVP as a CLI-first autonomous coding agent, then put a VS Code extension on top of the same core.

For the first version, keep the architecture deliberately small:

                    ┌──────────────┐
                    │    CLI       │
                    └──────┬───────┘
                           │
                           ▼
                  ┌─────────────────┐
                  │   Agent Loop    │
                  │                 │
                  │ model → tool    │
                  │ tool → model    │
                  └────────┬────────┘
                           │
          ┌────────────────┼────────────────┐
          ▼                ▼                ▼
     filesystem          search          terminal
          │                │                │
          └────────────────┼────────────────┘
                           ▼
                      Git / repo


I'll use the OpenAI Responses API in the example; current OpenAI documentation says the latest models support the Responses API and function tools. 
O
OpenAI Platform

1. MVP scope

Don't implement these yet:

embeddings
vector DB
LSP
MCP
autocomplete
multi-agent
browser
VS Code UI
sophisticated planning graphs

Your MVP should support:

repository inspection
file reading
file writing
patch/editing
code search
shell commands
git diff/status
iterative test/fix loop
basic safety restrictions
conversation history
streaming-ish terminal output
max iteration protection

The success criterion is:

Give it a real Git repository and a bug/feature request, and it can make the change and get the tests passing.

2. Project structure

I'd use TypeScript + Node.js.

cursor-clone/
│
├── src/
│   ├── index.ts
│   │
│   ├── agent/
│   │   ├── agent.ts
│   │   ├── context.ts
│   │   ├── prompt.ts
│   │   └── types.ts
│   │
│   ├── llm/
│   │   ├── client.ts
│   │   └── tools.ts
│   │
│   ├── tools/
│   │   ├── index.ts
│   │   ├── filesystem.ts
│   │   ├── search.ts
│   │   ├── terminal.ts
│   │   └── git.ts
│   │
│   ├── repo/
│   │   ├── scanner.ts
│   │   └── ignore.ts
│   │
│   └── utils/
│       ├── paths.ts
│       └── truncate.ts
│
├── tests/
│   ├── filesystem.test.ts
│   ├── search.test.ts
│   └── agent.test.ts
│
├── package.json
├── tsconfig.json
├── .env
└── README.md


The important architectural boundary is:

agent/
    knows WHAT it wants

tools/
    knows HOW to do it

llm/
    knows HOW to communicate with model

repo/
    knows HOW repository is structured


Don't mix those.

3. Initialize the project
mkdir cursor-clone
cd cursor-clone

npm init -y

npm install openai dotenv zod
npm install -D typescript tsx @types/node vitest

npx tsc --init


I'd use Node 22+.

package.json:

{
  "name": "cursor-clone",
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "tsx src/index.ts",
    "build": "tsc",
    "test": "vitest",
    "start": "node dist/index.js"
  },
  "dependencies": {
    "dotenv": "^17.0.0",
    "openai": "^5.0.0",
    "zod": "^4.0.0"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "tsx": "^4.0.0",
    "typescript": "^5.0.0",
    "vitest": "^3.0.0"
  }
}

4. TypeScript configuration
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": [
    "src/**/*.ts"
  ]
}

5. Environment

.env

OPENAI_API_KEY=your_key_here
MODEL=gpt-5.6-luna
MAX_ITERATIONS=30


Don't hard-code API keys.

6. Core types

src/agent/types.ts

export type ToolName =
  | "list_files"
  | "read_file"
  | "write_file"
  | "edit_file"
  | "search"
  | "run_command"
  | "git_status"
  | "git_diff";

export interface ToolCall {
  id: string;
  name: ToolName;
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  toolCallId: string;
  name: string;
  output: string;
  success: boolean;
}

export interface AgentConfig {
  repoRoot: string;
  maxIterations: number;
  model: string;
}

export interface AgentState {
  userRequest: string;
  iteration: number;
  toolCalls: number;
  filesChanged: Set<string>;
  history: unknown[];
}

7. Path security

This is important.

Never trust:

../../../../.ssh/id_rsa


from an LLM.

src/utils/paths.ts:

import path from "node:path";

export function resolveInsideRepo(
  repoRoot: string,
  requestedPath: string
): string {
  const root = path.resolve(repoRoot);
  const resolved = path.resolve(root, requestedPath);

  if (
    resolved !== root &&
    !resolved.startsWith(root + path.sep)
  ) {
    throw new Error(
      `Path escapes repository: ${requestedPath}`
    );
  }

  return resolved;
}


Every filesystem operation should go through this.

8. File system tools
read_file
import fs from "node:fs/promises";
import { resolveInsideRepo } from "../utils/paths.js";

export async function readFile(
  repoRoot: string,
  filePath: string
): Promise<string> {
  const absolute = resolveInsideRepo(
    repoRoot,
    filePath
  );

  const stat = await fs.stat(absolute);

  if (!stat.isFile()) {
    throw new Error(`${filePath} is not a file`);
  }

  const content = await fs.readFile(
    absolute,
    "utf8"
  );

  const MAX_CHARS = 100_000;

  if (content.length > MAX_CHARS) {
    return (
      content.slice(0, MAX_CHARS) +
      "\n\n[FILE TRUNCATED]"
    );
  }

  return content;
}

9. List files

Don't make the model discover the repo through thousands of shell commands.

Give it a clean tool.

import fs from "node:fs/promises";
import path from "node:path";

const IGNORED = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  "coverage",
  ".cache"
]);

export async function listFiles(
  repoRoot: string,
  relative = "."
): Promise<string> {
  const root = path.resolve(repoRoot, relative);

  const results: string[] = [];

  async function walk(dir: string) {
    const entries = await fs.readdir(dir, {
      withFileTypes: true
    });

    for (const entry of entries) {
      if (IGNORED.has(entry.name)) {
        continue;
      }

      const full = path.join(dir, entry.name);
      const rel = path.relative(
        repoRoot,
        full
      );

      if (entry.isDirectory()) {
        await walk(full);
      } else {
        results.push(rel);
      }

      if (results.length >= 5000) {
        return;
      }
    }
  }

  await walk(root);

  return results.join("\n");
}

10. Search

For the MVP, use rg.

It's dramatically easier than building your own search engine.

src/tools/search.ts

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function search(
  repoRoot: string,
  query: string
): Promise<string> {
  if (!query.trim()) {
    throw new Error("Search query cannot be empty");
  }

  const { stdout } = await execFileAsync(
    "rg",
    [
      "--line-number",
      "--hidden",
      "--glob", "!.git/**",
      "--glob", "!node_modules/**",
      "--glob", "!dist/**",
      query,
      "."
    ],
    {
      cwd: repoRoot,
      maxBuffer: 2 * 1024 * 1024
    }
  );

  return stdout.slice(0, 50_000);
}


Later:

rg
 ↓
tree-sitter
 ↓
symbol index
 ↓
LSP
 ↓
semantic retrieval


But don't start there.

11. Terminal tool

This is the most dangerous tool.

For your local development MVP, you can implement it directly, but keep a command timeout and output limit.

import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

const BLOCKED = [
  "sudo ",
  "rm -rf /",
  "rm -rf ~",
  "mkfs",
  "shutdown",
  "reboot"
];

export async function runCommand(
  repoRoot: string,
  command: string
): Promise<string> {
  const normalized = command.trim();

  for (const blocked of BLOCKED) {
    if (normalized.includes(blocked)) {
      throw new Error(
        `Blocked potentially destructive command: ${command}`
      );
    }
  }

  const { stdout, stderr } = await execAsync(
    normalized,
    {
      cwd: repoRoot,
      timeout: 120_000,
      maxBuffer: 2 * 1024 * 1024
    }
  );

  return [
    stdout,
    stderr
  ]
    .filter(Boolean)
    .join("\n")
    .slice(0, 50_000);
}


Important: this is not a production sandbox.

When you turn this into a real service, execute agent commands inside an isolated container/VM rather than your application host.

12. Git tools

src/tools/git.ts

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function git(
  repoRoot: string,
  args: string[]
): Promise<string> {
  const { stdout, stderr } =
    await execFileAsync(
      "git",
      args,
      {
        cwd: repoRoot,
        maxBuffer: 2 * 1024 * 1024
      }
    );

  return `${stdout}${stderr}`.slice(0, 100_000);
}

export function gitStatus(repoRoot: string) {
  return git(repoRoot, [
    "status",
    "--short"
  ]);
}

export function gitDiff(repoRoot: string) {
  return git(repoRoot, [
    "diff",
    "--no-ext-diff"
  ]);
}

13. Write file
import fs from "node:fs/promises";
import path from "node:path";
import { resolveInsideRepo } from "../utils/paths.js";

export async function writeFile(
  repoRoot: string,
  filePath: string,
  content: string
): Promise<string> {
  const absolute = resolveInsideRepo(
    repoRoot,
    filePath
  );

  await fs.mkdir(
    path.dirname(absolute),
    { recursive: true }
  );

  await fs.writeFile(
    absolute,
    content,
    "utf8"
  );

  return `Wrote ${filePath}`;
}

14. Edit file

For MVP, give the model a simple exact replacement operation.

import fs from "node:fs/promises";
import { resolveInsideRepo } from "../utils/paths.js";

export async function editFile(
  repoRoot: string,
  filePath: string,
  oldText: string,
  newText: string
): Promise<string> {
  const absolute = resolveInsideRepo(
    repoRoot,
    filePath
  );

  const content = await fs.readFile(
    absolute,
    "utf8"
  );

  const occurrences =
    content.split(oldText).length - 1;

  if (occurrences === 0) {
    throw new Error(
      "oldText was not found in the file"
    );
  }

  if (occurrences > 1) {
    throw new Error(
      `oldText matched ${occurrences} times. ` +
      "Provide a more specific snippet."
    );
  }

  const updated = content.replace(
    oldText,
    newText
  );

  await fs.writeFile(
    absolute,
    updated,
    "utf8"
  );

  return `Edited ${filePath}`;
}


This is intentionally conservative.

15. Tool registry

Now combine them.

src/tools/index.ts

import { listFiles } from "./filesystem.js";
import { readFile } from "./filesystem.js";
import { writeFile } from "./filesystem.js";
import { editFile } from "./filesystem.js";
import { search } from "./search.js";
import { runCommand } from "./terminal.js";
import { gitStatus, gitDiff } from "./git.js";

export async function executeTool(
  repoRoot: string,
  name: string,
  args: Record<string, unknown>
): Promise<string> {
  switch (name) {
    case "list_files":
      return listFiles(
        repoRoot,
        String(args.path ?? ".")
      );

    case "read_file":
      return readFile(
        repoRoot,
        String(args.path)
      );

    case "write_file":
      return writeFile(
        repoRoot,
        String(args.path),
        String(args.content)
      );

    case "edit_file":
      return editFile(
        repoRoot,
        String(args.path),
        String(args.old_text),
        String(args.new_text)
      );

    case "search":
      return search(
        repoRoot,
        String(args.query)
      );

    case "run_command":
      return runCommand(
        repoRoot,
        String(args.command)
      );

    case "git_status":
      return gitStatus(repoRoot);

    case "git_diff":
      return gitDiff(repoRoot);

    default:
      throw new Error(
        `Unknown tool: ${name}`
      );
  }
}

16. LLM tool definitions

This is where the agent becomes an agent.

src/llm/tools.ts

export const tools = [
  {
    type: "function",
    name: "list_files",
    description:
      "List files in the repository. " +
      "Use this to understand repository structure.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Relative directory path. Defaults to '.'."
        }
      },
      required: []
    }
  },

  {
    type: "function",
    name: "read_file",
    description:
      "Read a text file from the repository.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Repository-relative file path."
        }
      },
      required: ["path"]
    }
  },

  {
    type: "function",
    name: "write_file",
    description:
      "Create or completely replace a file.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string"
        },
        content: {
          type: "string"
        }
      },
      required: ["path", "content"]
    }
  },

  {
    type: "function",
    name: "edit_file",
    description:
      "Make one precise replacement in an existing file.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string"
        },
        old_text: {
          type: "string"
        },
        new_text: {
          type: "string"
        }
      },
      required: [
        "path",
        "old_text",
        "new_text"
      ]
    }
  },

  {
    type: "function",
    name: "search",
    description:
      "Search repository source code using ripgrep.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string"
        }
      },
      required: ["query"]
    }
  },

  {
    type: "function",
    name: "run_command",
    description:
      "Run a shell command in the repository.",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string"
        }
      },
      required: ["command"]
    }
  },

  {
    type: "function",
    name: "git_status",
    description:
      "Show git working tree status.",
    parameters: {
      type: "object",
      properties: {},
      required: []
    }
  },

  {
    type: "function",
    name: "git_diff",
    description:
      "Show current git diff.",
    parameters: {
      type: "object",
      properties: {},
      required: []
    }
  }
] as const;

17. System prompt

This is one of the most important pieces.

src/agent/prompt.ts

export const SYSTEM_PROMPT = `
You are an autonomous software engineering agent.

Your job is to modify the user's repository to accomplish
the requested task.

GENERAL RULES

1. Inspect the repository before making changes.
2. Do not guess the contents of files.
3. Read relevant files before editing them.
4. Search the repository when you need to locate code.
5. Make the smallest correct change.
6. Preserve existing architecture and conventions.
7. Do not modify unrelated files.
8. After making changes, inspect git diff.
9. Run relevant tests, type checks, linting, or build commands.
10. If tests fail, investigate the failure and fix it.
11. Continue until the requested task is complete.
12. Never claim success without verifying the result.

REPOSITORY EXPLORATION

Start by understanding the repository structure.

Useful tools:
- list_files
- search
- read_file

Do not read thousands of files unnecessarily.
Use search to narrow down relevant code.

EDITING

Prefer edit_file for small changes.

Use write_file when:
- creating a new file
- replacing an entire file is genuinely necessary

When editing:
- preserve formatting
- preserve imports
- preserve surrounding code
- avoid unrelated refactoring

TESTING

After implementation, determine the appropriate
verification command from package.json, project configuration,
or repository conventions.

Examples:
- npm test
- npm run test
- npm run build
- npm run lint
- npx tsc --noEmit

Do not blindly run expensive commands when a targeted test
is available.

GIT

Before finishing:
- inspect git status
- inspect git diff

Do not commit changes unless explicitly requested.

SAFETY

Never intentionally access:
- SSH private keys
- cloud credentials
- environment secrets
- files outside the repository

Do not perform destructive operations unless explicitly
requested and necessary.

COMMUNICATION

Use tools for actions.
Do not merely describe what you would do.

When finished, provide:
- summary of changes
- tests/checks run
- any remaining concerns
`;

18. The agent loop

Now the important part.

src/agent/agent.ts

Conceptually:

user request
     ↓
model
     ↓
tool call?
 ┌───┴────┐
yes       no
 ↓         ↓
execute   final
 ↓
result
 ↓
model
 ↓
...


Implementation:

import OpenAI from "openai";
import { executeTool } from "../tools/index.js";
import { tools } from "../llm/tools.js";
import { SYSTEM_PROMPT } from "./prompt.js";

export interface AgentOptions {
  repoRoot: string;
  model: string;
  maxIterations: number;
}

export class Agent {
  private client: OpenAI;

  constructor(
    private options: AgentOptions
  ) {
    this.client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    });
  }

  async run(
    userRequest: string
  ): Promise<string> {
    const input: any[] = [
      {
        role: "user",
        content: userRequest
      }
    ];

    for (
      let iteration = 0;
      iteration < this.options.maxIterations;
      iteration++
    ) {
      console.log(
        `\n--- iteration ${iteration + 1} ---`
      );

      const response =
        await this.client.responses.create({
          model: this.options.model,
          instructions: SYSTEM_PROMPT,
          tools: tools as any,
          input
        });

      for (const item of response.output) {
        input.push(item as any);
      }

      const toolCalls =
        response.output.filter(
          (item: any) =>
            item.type === "function_call"
        ) as any[];

      if (toolCalls.length === 0) {
        return response.output_text;
      }

      for (const call of toolCalls) {
        console.log(
          `\n> ${call.name}`
        );

        let args: Record<string, unknown>;

        try {
          args = JSON.parse(
            call.arguments
          );
        } catch {
          const output =
            "Invalid JSON arguments";

          input.push({
            type: "function_call_output",
            call_id: call.call_id,
            output
          });

          continue;
        }

        console.log(
          JSON.stringify(args, null, 2)
        );

        try {
          const result =
            await executeTool(
              this.options.repoRoot,
              call.name,
              args
            );

          console.log(
            result.slice(0, 1000)
          );

          input.push({
            type: "function_call_output",
            call_id: call.call_id,
            output: result
          });
        } catch (error) {
          const message =
            error instanceof Error
              ? error.message
              : String(error);

          console.error(
            `Tool error: ${message}`
          );

          input.push({
            type: "function_call_output",
            call_id: call.call_id,
            output:
              `TOOL ERROR: ${message}`
          });
        }
      }
    }

    throw new Error(
      `Agent exceeded ${this.options.maxIterations} iterations`
    );
  }
}


That is the core of the entire application.

19. CLI

src/index.ts

import "dotenv/config";
import path from "node:path";
import process from "node:process";
import { Agent } from "./agent/agent.js";

async function main() {
  const request =
    process.argv.slice(2).join(" ");

  if (!request) {
    console.error(
      'Usage: npm run dev -- "your task"'
    );

    process.exit(1);
  }

  const repoRoot =
    process.cwd();

  const model =
    process.env.MODEL ??
    "gpt-5.6-luna";

  const maxIterations =
    Number(
      process.env.MAX_ITERATIONS ?? 30
    );

  console.log(
    `Repository: ${path.resolve(repoRoot)}`
  );

  console.log(
    `Model: ${model}`
  );

  const agent = new Agent({
    repoRoot,
    model,
    maxIterations
  });

  const result =
    await agent.run(request);

  console.log("\n\n=== RESULT ===\n");

  console.log(result);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});


Now:

npm run dev -- "Fix the failing authentication test"

20. Your first real test

Create a deliberately broken repository.

For example:

function add(a: number, b: number) {
  return a - b;
}

export { add };


Test:

import { describe, expect, it } from "vitest";
import { add } from "./math";

describe("add", () => {
  it("adds numbers", () => {
    expect(add(2, 3)).toBe(5);
  });
});


Run:

npm test


It fails.

Now:

npm run dev -- "Fix the failing test in this repository."


The expected trajectory is:

list_files
      ↓
read package.json
      ↓
search "add("
      ↓
read math.ts
      ↓
read math.test.ts
      ↓
edit_file
      ↓
run_command "npm test"
      ↓
git_diff
      ↓
final response


That's your first real coding agent.

21. Improve the agent loop immediately

The simple implementation above works, but there are several things I'd add next.

A. Track changed files

Don't rely only on the model's memory.

After every write/edit:

state.filesChanged.add(
  String(args.path)
);


Then at the end:

Changed:
- src/auth.ts
- src/auth.test.ts

B. Automatically inspect diff

At the end of the agent:

const diff = await executeTool(
  repoRoot,
  "git_diff",
  {}
);


Then send it back to the model:

Review your changes.
Check whether they are minimal and correct.


This creates a useful second-pass review.

22. Add a verification phase

I'd make the agent explicitly transition through:

EXPLORE
   ↓
PLAN
   ↓
IMPLEMENT
   ↓
VERIFY
   ↓
REVIEW
   ↓
DONE


You don't need a complicated state machine.

Just put the phase into state:

type AgentPhase =
  | "explore"
  | "implement"
  | "verify"
  | "review"
  | "done";


Then tell the model:

Current phase: VERIFY


This tends to make long-running agents more disciplined.

23. Add automatic loop detection

One common agent failure looks like:

read_file
edit_file
test
edit_file
test
edit_file
test
...


Or:

search X
search X
search X


Track calls:

const recentCalls: string[] = [];


Then:

const signature =
  `${call.name}:${JSON.stringify(args)}`;

recentCalls.push(signature);

if (recentCalls.length > 8) {
  recentCalls.shift();
}

const repeats =
  recentCalls.filter(
    x => x === signature
  ).length;

if (repeats >= 3) {
  throw new Error(
    "Agent appears to be repeating the same action."
  );
}


This is crude but useful.

24. Add token/context management

Your first implementation will eventually hit:

tool output
tool output
tool output
tool output
tool output
...


and your context becomes enormous.

Don't solve this with vector DB immediately.

First implement:

function truncate(
  text: string,
  maxChars: number
) {
  if (text.length <= maxChars) {
    return text;
  }

  return (
    text.slice(0, maxChars) +
    "\n...[truncated]"
  );
}


Then establish budgets:

file read:      50k chars
search:         30k
terminal:       30k
git diff:       50k


Later you'll want intelligent context compaction.

25. Repository map

After the basic agent works, create:

Repository:

Language: TypeScript

Files:
src/
  agent/
  tools/
  llm/

Important:
package.json
tsconfig.json
README.md


You can generate this automatically.

The model receives:

<repository>
...
</repository>


before the user's task.

This is much cheaper than repeatedly asking:

list_files

26. Add package.json awareness

A coding agent should immediately inspect:

{
  "scripts": {
    "test": "vitest",
    "build": "tsc",
    "lint": "eslint ."
  }
}


You can automatically read package metadata.

For Node repositories:

const packageJson = await readFile(
  repoRoot,
  "package.json"
);


Then expose:

Available commands:

test  → vitest
build → tsc
lint  → eslint


This helps the agent choose verification commands.

27. Don't make the model write huge files

One mistake many first agent implementations make:

"Here's the entire 2,000-line file..."


and then:

write_file(content=2000 lines)


Prefer:

read
 ↓
locate exact section
 ↓
edit


For new files:

write_file


For modifications:

edit_file


Later replace edit_file with a robust patch engine.

28. Better editing: unified patches

Your second-generation tool should look like:

{
  "path": "src/auth.ts",
  "patch": "@@ -10,7 +10,8 @@ ..."
}


Then:

LLM
 ↓
unified diff
 ↓
patch parser
 ↓
validate
 ↓
apply


This gets you closer to how professional coding agents operate.

29. The next major upgrade: repository intelligence

Once MVP works, this becomes your architecture:

                  Repository
                       │
             ┌─────────┼─────────┐
             ▼         ▼         ▼
          Text       AST       Git
          index      index    history
             │         │         │
             └─────────┼─────────┘
                       ▼
                Context Engine
                       │
                       ▼
                    Agent


For TypeScript:

tree-sitter


can give you:

function definitions
classes
imports
exports
interfaces
methods


Then your search tool can evolve from:

search("authenticate")


to:

find_symbol("AuthService")
find_references("authenticate")
find_definition("UserRepository")


That is where the agent starts becoming genuinely powerful.

30. Then add LSP

Once repository search is good:

Agent
 │
 ├── text search
 ├── AST
 └── LSP
      ├── definition
      ├── references
      ├── diagnostics
      ├── hover
      └── rename


For example:

Rename UserService.authenticate to login.

Instead of hoping the LLM finds every reference, use the language server.

That's a huge reliability improvement.

31. Then add a VS Code extension

Don't rewrite your agent.

Your architecture should become:

                 VS Code
                    │
              WebSocket/IPC
                    │
                    ▼
              Agent Server
                    │
          ┌─────────┼─────────┐
          ▼         ▼         ▼
        Agent     Tools      LSP
          │         │
          └────┬────┘
               ▼
              LLM


The CLI and VS Code extension both talk to the same Agent.

For example:

interface AgentServer {
  startTask(request: string): Promise<string>;
  cancelTask(id: string): void;
  getEvents(id: string): AsyncIterable<AgentEvent>;
}


This prevents your UI from becoming entangled with your agent logic.

32. VS Code UI MVP

Your first extension only needs:

┌─────────────────────────────────┐
│ AI Agent                        │
├─────────────────────────────────┤
│                                 │
│ > Fix authentication bug        │
│                                 │
│ Agent:                          │
│ Looking at auth middleware...   │
│                                 │
│ ✓ Read auth.ts                  │
│ ✓ Found failing test            │
│ ✓ Modified auth.ts              │
│ ✓ Tests passing                 │
│                                 │
├─────────────────────────────────┤
│ Ask the agent...                │
└─────────────────────────────────┘


And when changes happen:

┌──────────────────────────────┐
│ Changes                      │
├──────────────────────────────┤
│ M src/auth.ts                │
│ M src/auth.test.ts           │
│                              │
│ [Review] [Accept] [Reject]  │
└──────────────────────────────┘


That's already surprisingly close to the useful part of Cursor.

33. Architecture I would target after MVP

Eventually:

                         ┌──────────────────┐
                         │   VS Code / IDE  │
                         └────────┬─────────┘
                                  │
                                  ▼
                         ┌──────────────────┐
                         │   Agent Server   │
                         └────────┬─────────┘
                                  │
              ┌───────────────────┼────────────────────┐
              │                   │                    │
              ▼                   ▼                    ▼
       ┌─────────────┐     ┌─────────────┐      ┌────────────┐
       │ Agent Core  │     │ Context     │      │ Task Queue │
       │             │     │ Engine      │      │            │
       └──────┬──────┘     └──────┬──────┘      └────────────┘
              │                   │
              │             ┌─────┼─────┐
              │             ▼     ▼     ▼
              │           AST    LSP   Search
              │
        ┌─────┴──────────────────────────────┐
        │                                    │
        ▼                                    ▼
 ┌──────────────┐                     ┌──────────────┐
 │ Tool Runtime │                     │ Model Router │
 ├──────────────┤                     ├──────────────┤
 │ filesystem   │                     │ fast model   │
 │ terminal     │                     │ coding model │
 │ git          │                     │ reasoning    │
 │ browser      │                     │ embeddings   │
 └──────┬───────┘                     └──────────────┘
        │
        ▼
 ┌──────────────┐
 │   Sandbox    │
 └──────────────┘


That's the real product architecture I'd aim toward.

34. The development sequence I'd personally follow
Week 1

Build:

CLI
LLM
tool calling
read
write
edit
search
terminal
git


Goal:

agent "Fix this bug"


actually works.

Week 2

Add:

context management
repository map
loop detection
iteration limits
test verification
diff review
better errors


Goal:

Agent can solve small real-world issues reliably.

Week 3

Add:

tree-sitter
symbol search
AST


Goal:

Agent can navigate medium-sized repositories.

Week 4

Add:

LSP
diagnostics
references
definitions


Goal:

Agent understands code relationships.

Week 5

Build:

VS Code extension
streaming events
diff UI
accept/reject
cancel


Goal:

Usable Cursor-like MVP.

Week 6+

Then:

MCP
background agents
task queue
sandbox
multi-model routing
embeddings
autocomplete
PR generation
code review

35. One thing I'd change from your original "Cursor clone" idea

Don't optimize for features first.

Optimize for this benchmark:

100 real coding tasks
        │
        ▼
┌─────────────────────┐
│      Your Agent     │
└─────────┬───────────┘
          │
          ▼
     tests passing?
          │
      ┌───┴───┐
      │       │
     yes      no
      │       │
      ▼       ▼
    success  failure


Track:

Metric	Target for MVP
Task success	>60%
Tests passing	>75%
Unnecessary file changes	<10%
Agent loops	<5%
Avg task duration	<2 min
Fatal tool errors	<2%

Then improve the architecture based on failures.

That's much more valuable than spending three weeks building a beautiful chat interface.

Your first milestone

I would make your first milestone extremely concrete:

git clone your-test-repo
cd your-test-repo

agent "Add pagination to GET /users. Add tests."


And the agent should autonomously produce:

1. Inspect repository
2. Find users route
3. Find controller/service
4. Find existing tests
5. Implement pagination
6. Add tests
7. Run tests
8. Fix failures
9. Show git diff
10. Explain result


If you can get that working reliably, you have the core of a Cursor clone.

If you want to actually start coding this now, the best next step is to implement Milestone 1 as a complete runnable repo. I can give you the next piece as a cohesive ~1,000-line implementation with the files above wired together, including the exact OpenAI tool-calling loop, Vitest tests, CLI argument handling, repository scanner, diff verification, and a small sample repo for testing.

O
Sources