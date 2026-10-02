import { z } from "zod";
import { toolRegistry } from "../tools/index.js";
/**
 * OpenAI Responses API function-tool definitions.
 * Keep descriptions imperative and narrow: the model chooses tools
 * based on these strings, so each one should state WHEN to use it.
 */
export const tools = [...toolRegistry.values()].map((def) => ({
  type: "function" as const,
  name: def.name,
  description: def.description,
  parameters: z.toJSONSchema(def.schema, { unrepresentable: "any" }) as {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  },
}));

export type LlmToolName = (typeof tools)[number]["name"];

/**
 * Chat Completions variant of the same tool set
 * ({ type: "function", function: {...} } shape).
 * Lazily typed against the OpenAI namespace to avoid a hard
 * dependency from this module on the SDK client.
 */
export function toChatTools(filter?: {
  exclude?: string[];
  definitions?: import("./events.js").WireTool[];
}): Array<{
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}> {
  const available = filter?.definitions ?? tools;
  const list = filter?.exclude?.length
    ? available.filter((t) => !filter.exclude!.includes(t.name))
    : available;
  return list.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters as unknown as Record<string, unknown>,
    },
  }));
}

/**
 * Phase 2 tool assembly: which tools are offered under a flag set.
 * - hideGitOutsideRepo: omit git_status/diff/log when not in a git repo.
 * - skipSmallTodos: omit todo_write when the repo has <= 8 source files.
 * - webUnavailable: omit web_search when no WEB_SEARCH_ENDPOINT is set.
 * Pure + unit-tested; the live loop passes the computed exclude list to
 * toChatTools() and executeTool enforces the same rule fail-closed.
 *
 * Capability guards (git + web) are always on: even with flags off, a
 * known-false capability hides the tool so the model never hallucinates it.
 */
export function toolExcludesForRuntime(opts: {
  hygieneOn?: boolean;
  economyOn?: boolean;
  isGitRepo?: boolean;
  sourceFileCount?: number;
  webAvailable?: boolean;
}): string[] {
  const out: string[] = [];
  // Git: hide when known-not-a-repo regardless of hygiene flag (manual-test fix).
  if (opts.isGitRepo === false) {
    out.push("git_status", "git_diff", "git_log");
  }
  if (
    opts.economyOn &&
    typeof opts.sourceFileCount === "number" &&
    opts.sourceFileCount <= 8
  ) {
    out.push("todo_write");
  }
  // Web: hide when no provider is configured (Tavily key or generic endpoint).
  const webOff =
    opts.webAvailable === false ||
    (opts.webAvailable === undefined && !isWebAvailable());
  if (webOff && !out.includes("web_search")) {
    out.push("web_search");
  }
  return [...new Set(out)];
}

/** True when web_search can actually run (Tavily key or generic endpoint). */
export function isWebAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.TAVILY_API_KEY?.trim() || env.WEB_SEARCH_ENDPOINT?.trim());
}
