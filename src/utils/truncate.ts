/**
 * Truncate long model-facing output to a character budget.
 * Keeps the head (most relevant part for file reads / search hits)
 * and marks truncation explicitly so the model knows output was cut.
 */
export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + "\n...[truncated]";
}

/** Per-tool output budgets (chars). Tuned to keep context small. */
export const TRUNCATION_BUDGETS = {
  fileRead: 30_000,
  listFiles: 15_000,
  search: 30_000,
  terminal: 30_000,
  gitDiff: 50_000,
  gitStatus: 10_000,
} as const;
