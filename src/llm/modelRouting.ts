import type { ModelSettings } from "../agent/settings.js";

/** Model roles: main / fast / plan (ML-5 remainder). */

export interface ModelRoles {
  main?: string;
  fast?: string;
  plan?: string;
}

export function resolveRoles(settings: ModelSettings, fallbackMain?: string): Required<Pick<ModelRoles, "main">> & ModelRoles {
  const main = settings.main ?? fallbackMain ?? process.env.MODEL ?? "gpt-5.6-luna";
  return {
    main,
    fast: settings.fast ?? main,
    plan: settings.plan ?? main,
  };
}

/** Per-tool plan-role routing: exploration tools prefer the plan model when configured. */
const PLAN_ROUTED_TOOLS = new Set(["grep", "glob", "search", "list_files", "read", "read_file", "view_file", "view_symbol_outline", "git_log", "web_fetch", "web_search"]);

export function resolveModelFor(toolName: string, roles: ModelRoles & { main?: string }): string {
  if (PLAN_ROUTED_TOOLS.has(toolName) && roles.plan && roles.plan !== roles.main) return roles.plan;
  return roles.main ?? roles.fast ?? roles.plan ?? "gpt-5.6-luna";
}

export function isPlanRoutedTool(toolName: string): boolean {
  return PLAN_ROUTED_TOOLS.has(toolName);
}
