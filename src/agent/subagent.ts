import { executeTool } from "../tools/index.js";
import type { Responder } from "../llm/client.js";
import {
  createProviderFromEnv,
  type ProviderOverrides,
} from "../llm/provider.js";
import { truncate } from "../utils/truncate.js";

export type SubagentType = "explore" | "plan" | (string & {});

export interface SubagentOptions {
  maxIterations?: number;
  responder?: Responder;
  signal?: AbortSignal;
  subagentType?: string;
  /** Inherited from the parent run (--model, --provider, --endpoint). */
  providerOverrides?: ProviderOverrides;
  /** Test hook. Production uses createProviderFromEnv with the inherited overrides. */
  createResponder?: (overrides?: ProviderOverrides) => Responder;
  /** Custom system prompt (user-defined subagents, AG-12). */
  systemPrompt?: string;
  /** Allowed tools override (user-defined subagents). */
  allowedTools?: string[];
  /** Repo root for registry lookup of custom defs. */
  repoRoot?: string;
}

const BASE_ALLOWED_SUBAGENT_TOOLS = new Set([
  "list_files",
  "read",
  "read_file",
  "view_file",
  "search",
  "grep",
  "glob",
  "view_symbol_outline",
]);

const ALLOWED_SUBAGENT_TOOLS = BASE_ALLOWED_SUBAGENT_TOOLS;

const EXPLORE_SYSTEM_PROMPT = `You are an Explorer Subagent for Codeagent. Your mission is to explore, search, and analyze the repository to answer the given research task.

RULES:
1. You have READ-ONLY tools: list_files, read_file, view_file, search, view_symbol_outline.
2. You CANNOT modify files, write code, or run shell commands.
3. Be targeted: use search and view_symbol_outline to find relevant code quickly.
4. Spawning parallel tool calls for searching and reading files is encouraged.
5. When you have enough information, reply with your final synthesized answer in this format:

### Findings
<direct answer with specific file paths and line references>

### Architecture & Key Components
<summary of how the relevant modules fit together>

### Next Actions for Main Agent
<recommended modifications or files to touch>
`;

const REVIEWER_SYSTEM_PROMPT = `You are a Reviewer Subagent for Codeagent. Read the provided diff/context and report issues only.
RULES:
1. You have READ-ONLY tools: list_files, read, read_file, view_file, search, grep, glob, view_symbol_outline.
2. You CANNOT modify files, write code, or run shell commands.
3. Reply in this format:

### Issues
<blocking issues with file:line>

### Nits
<non-blocking>

### Verdict
<approve | request-changes>
`;

const PLAN_SYSTEM_PROMPT = `You are a Software Architect and Planning Subagent for Codeagent. Your mission is to explore the codebase and design an implementation plan.

RULES:
1. You have READ-ONLY tools: list_files, read_file, view_file, search, view_symbol_outline.
2. You CANNOT modify files, write code, or run shell commands.
3. Explore thoroughly: examine existing conventions, architecture, and similar features as reference.
4. When you have enough information, reply with your final synthesized architectural plan in this format:

### Architecture & Approach
<trade-offs, design patterns, and overall implementation strategy>

### Step-by-Step Implementation Plan
1. <step 1 with specific file paths and function signatures>
2. <step 2...>

### Critical Files for Implementation
List 3-5 files most critical for implementing this plan:
- path/to/file1
- path/to/file2
`;

/**
 * Executes a focused, read-only exploration or planning task in an isolated context window.
 * Offloads multi-step search/reads so the main agent's context memory remains clean.
 */
export async function runSubagent(
  repoRoot: string,
  task: string,
  options?: SubagentOptions,
): Promise<string> {
  const { AgentRuntime } = await import("../runtime/runtime.js");
  const { loadSubagentDefs } = await import("./subagentsRegistry.js");
  const type = options?.subagentType ?? "explore";
  const definition = (await loadSubagentDefs(repoRoot)).find(
    (d) => d.name === type,
  );
  const overrides = {
    ...options?.providerOverrides,
    model: options?.providerOverrides?.model ?? definition?.model,
  };
  const responder = options?.responder ?? options?.createResponder?.(overrides);
  const requested = options?.allowedTools ??
    definition?.tools ?? [...BASE_ALLOWED_SUBAGENT_TOOLS];
  const allowedTools = requested.filter((name) =>
    BASE_ALLOWED_SUBAGENT_TOOLS.has(name),
  );
  const agent = new AgentRuntime({
    repoRoot,
    model: overrides.model ?? process.env.MODEL ?? "gpt-5.6-luna",
    maxIterations: options?.maxIterations ?? 5,
    provider: overrides.provider,
    baseURL: overrides.baseURL,
    responder,
    allowedTools,
    depth: 1,
    role: type,
    systemPrompt:
      options?.systemPrompt ??
      (type === "plan"
        ? PLAN_SYSTEM_PROMPT
        : type === "reviewer"
          ? REVIEWER_SYSTEM_PROMPT
          : definition?.systemPrompt) ??
      EXPLORE_SYSTEM_PROMPT,
    verbose: false,
  });
  const result = await agent.run(task, { signal: options?.signal });
  return `[SUBAGENT RESEARCH COMPLETE]\n${result.finalMessage}`;
}

/**
 * AG-12: bounded parallel subagent runs (default concurrency 3).
 * Results preserve input order; failures become TOOL ERROR strings.
 */
export async function runSubagentsParallel(
  repoRoot: string,
  tasks: Array<{ task: string; subagentType?: string }>,
  options?: SubagentOptions & { concurrency?: number },
): Promise<string[]> {
  const concurrency = Math.max(1, Math.min(5, options?.concurrency ?? 3));
  const results: string[] = new Array(tasks.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < tasks.length) {
      const idx = next++;
      const t = tasks[idx]!;
      try {
        results[idx] = await runSubagent(repoRoot, t.task, {
          ...options,
          subagentType: t.subagentType ?? options?.subagentType,
        });
      } catch (e) {
        results[idx] =
          `TOOL ERROR (run_subagent): ${e instanceof Error ? e.message : String(e)}`;
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker()),
  );
  return results;
}
