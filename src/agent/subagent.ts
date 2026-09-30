import { executeTool } from "../tools/index.js";
import type { Responder } from "../llm/client.js";
import { createProviderFromEnv, type ProviderOverrides } from "../llm/provider.js";
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
  const envCap = Number(process.env.SUBAGENT_MAX_ITERATIONS ?? 0);
  const maxIterations = options?.maxIterations
    ?? (Number.isFinite(envCap) && envCap > 0 ? Math.min(20, Math.floor(envCap)) : 5);
  const signal = options?.signal;
  const subagentType = options?.subagentType ?? "explore";
  let systemPrompt = options?.systemPrompt
    ?? (subagentType === "plan" ? PLAN_SYSTEM_PROMPT : subagentType === "reviewer" ? REVIEWER_SYSTEM_PROMPT : EXPLORE_SYSTEM_PROMPT);
  // User-defined subagents (AG-12): resolve Markdown defs by name when no explicit prompt given.
  // Def `tools` restrict the call set; def `model` selects the responder model.
  let defTools: string[] | undefined;
  let defModel: string | undefined;
  if (!options?.systemPrompt && subagentType !== "explore" && subagentType !== "plan" && subagentType !== "reviewer") {
    try {
      const { loadSubagentDefs } = await import("./subagentsRegistry.js");
      const defs = await loadSubagentDefs(options?.repoRoot ?? repoRoot);
      const def = defs.find((d) => d.name === subagentType);
      if (def?.systemPrompt) systemPrompt = def.systemPrompt;
      defTools = def?.tools;
      defModel = def?.model;
    } catch {
      // fall back to explorer prompt
    }
  }
  // AG-12 enforcement: effective allow-set is def.tools ?? explicit allowedTools ?? read-only base.
  const effectiveAllowed = new Set(
    options?.allowedTools ?? defTools ?? [...BASE_ALLOWED_SUBAGENT_TOOLS],
  );
  const allowed = effectiveAllowed;
  const providerOverrides = {
    ...(options?.providerOverrides ?? {}),
    // Def model wins when the caller did not pin one explicitly.
    ...(defModel && !options?.providerOverrides?.model ? { model: defModel } : {}),
  };
  const responder =
    options?.responder ??
    (options?.createResponder
      ? options.createResponder(providerOverrides)
      : createProviderFromEnv(process.env, providerOverrides).responder);

  const history: unknown[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: `Research Task: ${task}` },
  ];

  for (let i = 0; i < maxIterations; i++) {
    if (signal?.aborted) {
      throw new Error("Subagent cancelled by user.");
    }

    const result = await responder(history);
    for (const item of result.output) history.push(item);

    const toolCalls = result.output.filter((item) => item.type === "function_call");

    if (toolCalls.length === 0) {
      const summary = result.output_text?.trim() || "Subagent finished with no findings.";
      return `[SUBAGENT RESEARCH COMPLETE]\n${summary}\n\n[DIRECTIVE FOR MAIN AGENT]: Research has finished. Present the findings above to the user immediately or proceed to implementation. Do NOT re-read these files.`;
    }

    for (const call of toolCalls) {
      if (signal?.aborted) throw new Error("Subagent cancelled by user.");
      const callId = call.call_id ?? `subcall-${i}`;
      const name = String(call.name ?? "unknown");

      // AG-12: enforce the effective allow-set (def.tools or read-only base).
      if (!allowed.has(name)) {
        const errorMsg = options?.allowedTools || defTools
          ? `TOOL ERROR (${name}): Subagent '${subagentType}' cannot call '${name}'. Allowed: ${[...allowed].join(", ")}.`
          : `TOOL ERROR (${name}): Subagents only have read-only permissions. Cannot call '${name}'.`;
        history.push({ type: "function_call_output", call_id: callId, output: errorMsg });
        continue;
      }

      let args: Record<string, unknown> = {};
      try {
        args = call.arguments ? JSON.parse(call.arguments) : {};
      } catch {
        history.push({
          type: "function_call_output",
          call_id: callId,
          output: `TOOL ERROR (${name}): Malformed JSON arguments.`,
        });
        continue;
      }

      let output: string;
      try {
        output = await executeTool(repoRoot, name, args, signal);
        output = truncate(output, 8_000);
      } catch (err) {
        output = `TOOL ERROR (${name}): ${err instanceof Error ? err.message : String(err)}`;
      }

      history.push({ type: "function_call_output", call_id: callId, output });
    }
  }

  // If subagent exhausted iterations while reading files, do a fast rollup pass
  try {
    const finalPass = await responder([
      ...history,
      {
        role: "user",
        content: "Summarize everything you learned from the files inspected above now.",
      },
    ]);
    const summary = finalPass.output_text?.trim() || "Subagent completed exploration.";
    return `[SUBAGENT RESEARCH COMPLETE]\n${summary}\n\n[DIRECTIVE FOR MAIN AGENT]: Research has finished. Present the findings above to the user immediately or proceed to implementation. Do NOT re-read these files.`;
  } catch {
    return "[SUBAGENT RESEARCH COMPLETE]\nExploration completed across inspected files.\n\n[DIRECTIVE FOR MAIN AGENT]: Present findings to the user now.";
  }
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
        results[idx] = await runSubagent(repoRoot, t.task, { ...options, subagentType: t.subagentType ?? options?.subagentType });
      } catch (e) {
        results[idx] = `TOOL ERROR (run_subagent): ${e instanceof Error ? e.message : String(e)}`;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker()));
  return results;
}
