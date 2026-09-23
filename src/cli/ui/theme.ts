import path from "node:path";
import readline from "node:readline";
import pc from "picocolors";

export { pc };

export const icons = {
  logo: "▲",
  connected: "●",
  check: "✔",
  cross: "✖",
  info: "ℹ",
  warn: "⚠",
  branch: "⎇",
  sparkle: "⚡",
  search: "🔍",
  file: "📄",
  edit: "📝",
  cmd: "💻",
  folder: "📂",
  chat: "💬",
  session: "🏷️",
  arrowRight: "→",
};

export const colors = {
  brand: (s: string) => pc.bold(pc.cyan(s)),
  brandDim: (s: string) => pc.cyan(s),
  success: (s: string) => pc.green(s),
  warn: (s: string) => pc.yellow(s),
  error: (s: string) => pc.red(s),
  info: (s: string) => pc.cyan(s),
  accent: (s: string) => pc.magenta(s),
  dim: (s: string) => pc.dim(s),
  bold: (s: string) => pc.bold(s),
  inverse: (s: string) => pc.inverse(s),
  code: (s: string) => pc.yellow(s),
};

export function badge(text: string, type: "brand" | "success" | "warn" | "error" | "dim" = "brand"): string {
  switch (type) {
    case "brand":
      return pc.bgCyan(pc.black(` ${text} `));
    case "success":
      return pc.bgGreen(pc.black(` ${text} `));
    case "warn":
      return pc.bgYellow(pc.black(` ${text} `));
    case "error":
      return pc.bgRed(pc.white(` ${text} `));
    case "dim":
      return pc.bgBlack(pc.white(` ${text} `));
  }
}

/**
 * Formats the user's prompt as a full-width dark charcoal background bar — Claude Code style.
 * Uses TrueColor RGB (45, 49, 58) with 256-color fallback (237) and ANSI 100 for high contrast
 * and visibility on dark/black terminals.
 */
export function formatUserMessage(message: string, cols?: number): string {
  const terminalCols = Math.max(cols ?? (process.stdout.columns || 80), 40);
  // Dark charcoal slate background (TrueColor with 256-color fallback)
  const bg = "\x1b[48;2;45;49;58m\x1b[48;5;237m";
  const fgPrompt = "\x1b[36m\x1b[1m"; // cyan bold '>'
  const fgText = "\x1b[97m\x1b[1m";   // bold bright white
  const reset = "\x1b[0m";

  const lines = message.split("\n");
  return lines
    .map((line, idx) => {
      const prefix = idx === 0 ? " > " : "   ";
      const prefixStyled = idx === 0 ? `${fgPrompt}${prefix}` : prefix;
      const textStyled = `${fgText}${line}`;
      const visibleLength = prefix.length + line.length;
      const padLength = Math.max(0, terminalCols - visibleLength);
      const padding = " ".repeat(padLength);
      return `${bg}${prefixStyled}${textStyled}${padding}${reset}`;
    })
    .join("\n");
}

/**
 * Renders the user's prompt as a full-width dark background bar — Claude Code style.
 * Erases the readline echo line first so the message only appears once, replacing the
 * raw input with the styled bar.
 */
export function printUserMessage(message: string): void {
  // Erase the readline echo line (e.g. "▲ > hello") that was printed when the user hit Enter.
  // Move cursor up 1 line, clear the entire line, and return to column 0.
  if (process.stdout.isTTY) {
    readline.moveCursor(process.stdout, 0, -1);
    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);
  }
  // Also send VT100 / ANSI escape sequences as fallback:
  process.stdout.write("\x1b[1A\x1b[2K\r");

  // Output the styled message bar directly at that line (no leading newline!)
  const formatted = formatUserMessage(message);
  process.stdout.write(`${formatted}\n\n`);
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function formatPath(targetPath: string, root?: string): string {
  if (!root) return targetPath;
  const rel = path.relative(root, targetPath);
  return rel && !rel.startsWith("..") ? rel : targetPath;
}
