/**
 * Renderer spike for the Ink TUI (UI-1..UI-4).
 * These functions are the measurable core: incremental markdown, a diff card,
 * and a single-line input. The legacy REPL stays the default until the full
 * Ink app reaches parity behind --ui=next.
 */

export function renderMarkdownBlock(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      if (line.startsWith("### ")) return line.slice(4).toUpperCase();
      if (line.startsWith("## ")) return line.slice(3).toUpperCase();
      if (line.startsWith("# ")) return line.slice(2).toUpperCase();
      if (line.startsWith("- ")) return `  • ${line.slice(2)}`;
      return line;
    })
    .join("\n");
}

/** Append a delta without re-parsing the committed prefix. */
export function appendStream(committed: string, delta: string): string {
  return committed + delta;
}

export function renderDiffCard(path: string, preview: string): string {
  const body = preview
    .split("\n")
    .map((line) => {
      if (line.startsWith("+")) return `  + ${line.slice(1)}`;
      if (line.startsWith("-")) return `  - ${line.slice(1)}`;
      return `    ${line}`;
    })
    .join("\n");
  return [`Edit ${path}`, body, "Yes · Yes for session · Yes for project rule · No"].join("\n");
}

export function renderInputBox(value: string, cols = 80): string {
  const width = Math.max(20, cols);
  const shown = value.length > width - 4 ? value.slice(-(width - 4)) : value;
  return `> ${shown}`;
}

/** Render a long stream. Returns elapsed milliseconds. */
export function measureStreamRender(lines: number): number {
  const started = Date.now();
  let committed = "";
  for (let i = 0; i < lines; i++) {
    committed = appendStream(committed, `line ${i} some markdown - item\n`);
    if (i % 200 === 0) renderMarkdownBlock(committed.slice(-4000));
  }
  renderDiffCard("src/app.ts", "-1| const a = 1;\n+1| const a = 2;");
  renderInputBox("fix the failing test");
  return Date.now() - started;
}
