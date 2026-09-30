/**
 * F-13 split (3/3): input handling — multiline, bracketed paste, history search.
 * Pure helpers so the readline keypress math in repl.ts can migrate incrementally.
 */

export function collapseLargePaste(text: string, limit = 2000): string {
  if (text.length <= limit) return text;
  const lines = text.split("\n").length;
  return `[pasted ${text.length} chars / ${lines} lines — collapsed; first ${limit} chars shown]\n${text.slice(0, limit)}\n…`;
}

export function historySearch(history: string[], query: string): string[] {
  const q = query.toLowerCase();
  if (!q) return [...history].reverse().slice(0, 20);
  return history.filter((h) => h.toLowerCase().includes(q)).reverse().slice(0, 20);
}

export function shouldSubmitOnEnter(buffer: string, opts?: { shiftHeld?: boolean }): boolean {
  if (opts?.shiftHeld) return false; // Shift+Enter = newline (UI-5)
  return buffer.trim().length > 0;
}
