import { executeTool } from "../tools/index.js";
import type { Responder } from "../llm/client.js";
import { createProviderFromEnv } from "../llm/provider.js";
import { truncate } from "../utils/truncate.js";

export interface SubagentOptions {
  maxIterations?: number;
  responder?: Responder;
  signal?: AbortSignal;
}

const ALLOWED_SUBAGENT_TOOLS = new Set([
  "list_files",
  "read_file",
  "view_file",
  "search",
  "view_symbol_outline",
]);

const SUBAGENT_SYSTEM_PROMPT = `You are an Explorer Subagent. Your mission is to explore, search, and analyze the repository to answer the given research task.

RULES:
1. You have READ-ONLY tools: list_files, read_file, view_file, search, view_symbol_outline.
2. You CANNOT modify files, write code, or run shell commands.
3. Be targeted: use search and view_symbol_outline to find relevant code quickly.
4. When you have enough information, reply with your final synthesized answer in this format:

### Findings
<direct answer with specific file paths and line references>

### Architecture & Key Components
<summary of how the relevant modules fit together>

### Next Actions for Main Agent
<recommended modifications or files to touch>
`;

/**
 * Executes a focused, read-only exploration task in an isolated context window.
 * Offloads multi-step search/reads so the main agent's context memory remains clean.
 */
export async function runSubagent(
  repoRoot: string,
  task: string,
  options?: SubagentOptions,
): Promise<string> {
  const maxIterations = options?.maxIterations ?? 5;
  const signal = options?.signal;
  const responder =
    options?.responder ??
    createProviderFromEnv(process.env).responder;

  const history: unknown[] = [
    { role: "system", content: SUBAGENT_SYSTEM_PROMPT },
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

      if (!ALLOWED_SUBAGENT_TOOLS.has(name)) {
        const errorMsg = `TOOL ERROR (${name}): Subagents only have read-only permissions. Cannot call '${name}'.`;
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
