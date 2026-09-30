import type { ModelSettings } from "../agent/settings.js";

/** Small-model mode (ML-4): cheap/free models get a short prompt, fewer tools, JSON repair. */

const SMALL_MODEL_PATTERNS = [/gpt-oss/i, /mini/i, /haiku/i, /3\.5/i, /(^|[^0-9])7b/i, /(^|[^0-9])8b/i, /(^|[^0-9])13b/i, /qwen[^0-9]*(7b|8b|14b)/i, /llama[^0-9]*8b/i];

export function isSmallModel(model: string | undefined): boolean {
  if (!model) return false;
  return SMALL_MODEL_PATTERNS.some((re) => re.test(model));
}

export function isSmallModelMode(model: string | undefined, settings?: ModelSettings & { smallModel?: boolean }): boolean {
  if (settings?.smallModel === true) return true;
  if (settings?.smallModel === false) return false;
  return isSmallModel(model);
}

const SMALL_MODEL_TOOLS = new Set([
  "read", "list_files", "grep", "glob", "search", "view_symbol_outline",
  "write_file", "edit_file", "run_command", "git_status", "git_diff", "todo_write",
]);

export function filterToolsForSmallModel(toolNames: string[]): string[] {
  return toolNames.filter((t) => SMALL_MODEL_TOOLS.has(t));
}

export const SMALL_MODEL_SYSTEM_SUFFIX = `
SMALL-MODEL MODE: you run on a compact model. Rules:
- One tool call per turn. Never batch parallel calls.
- Keep reasoning under 3 sentences before acting.
- If a tool call fails with malformed JSON, retry once with a minimal valid object.
- Prefer read + edit_file over exploration loops.
`;

export function repairToolArgumentsJson(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "{}";
  try {
    JSON.parse(trimmed);
    return trimmed;
  } catch {
    // Common failure: trailing comma, single quotes, unquoted keys.
    let fixed = trimmed.replace(/,\s*([}\]])/g, "$1").replace(/'/g, '"');
    try {
      JSON.parse(fixed);
      return fixed;
    } catch {
      return "{}";
    }
  }
}
