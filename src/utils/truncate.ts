/**
 * Truncate long model-facing output to a character budget.
 * Keeps the head (most relevant part for file reads / search hits)
 * and marks truncation explicitly so the model knows output was cut.
 */
export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + "\n...[truncated]";
}

/** Per-tool output budgets (chars). Tuned to keep context small and stay within TPM limits. */
export const TRUNCATION_BUDGETS = {
  fileRead: 12_000,
  listFiles: 6_000,
  search: 8_000,
  terminal: 8_000,
  gitDiff: 12_000,
  gitStatus: 4_000,
} as const;
