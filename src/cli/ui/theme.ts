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

const ANSI_REGEX = /\x1b\[[0-9;]*[a-zA-Z]/g;

export function stripAnsi(str: string): string {
  return str.replace(ANSI_REGEX, "");
}

// Code point ranges that render as double-width (2 terminal cells).
const WIDE_CP_RANGES: Array<[number, number]> = [
  [0x1100, 0x115f], // Hangul Jamo
  [0x2e80, 0x303e], // CJK Radicals, Kangxi, CJK Symbols
  [0x3041, 0x33ff], // Hiragana, Katakana, CJK Compatibility
  [0x3400, 0x4dbf], // CJK Extension A
  [0x4e00, 0x9fff], // CJK Unified Ideographs
  [0xa000, 0xa4cf], // Yi Syllables
  [0xa960, 0xa97f], // Hangul Jamo Extended-A
  [0xac00, 0xd7a3], // Hangul Syllables
  [0xf900, 0xfaff], // CJK Compatibility Ideographs
  [0xfe10, 0xfe19], // Vertical forms
  [0xfe30, 0xfe6f], // CJK Compatibility Forms
  [0xff00, 0xff60], // Fullwidth Forms
  [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f], // Emoji (miscellaneous symbols & pictographs)
  [0x1f680, 0x1f6ff], // Emoji (transport & map)
  [0x1f900, 0x1f9ff], // Emoji (supplemental)
  [0x1fa70, 0x1faff], // Emoji (extended-A)
  [0x20000, 0x3fffd], // CJK Extension B and beyond
];

// Zero-width: variation selectors, ZWJ, combining marks, soft hyphen.
const ZERO_WIDTH_REGEX = /[\u00ad\u200b-\u200f\u2060\u20d0-\u20ef\ufe00-\ufe0f]/;

function isWideCodePoint(cp: number): boolean {
  for (const [lo, hi] of WIDE_CP_RANGES) {
    if (cp >= lo && cp <= hi) return true;
  }
  return false;
}

/**
 * Approximate terminal display width of a string in cells: strips ANSI
 * escape sequences, counts East-Asian and emoji code points as 2 cells,
 * and skips zero-width joiners / variation selectors.
 */
export function stringWidth(str: string): number {
  const plain = stripAnsi(str);
  let width = 0;
  for (const ch of plain) {
    const cp = ch.codePointAt(0)!;
    if (ZERO_WIDTH_REGEX.test(ch)) continue;
    width += isWideCodePoint(cp) ? 2 : 1;
  }
  return width;
}

/**
 * Number of terminal lines the readline echo block (prompt + typed input)
 * occupies after the user presses Enter, wrapping at `cols` columns.
 */
export function echoLineCount(prompt: string, input: string, cols: number): number {
  const effectiveCols = cols > 0 ? cols : 80;
  const total = stringWidth(prompt) + stringWidth(input);
  return Math.max(1, Math.ceil(total / effectiveCols));
}

/**
 * Formats the user's prompt as a full-width dark charcoal background bar — Claude Code style.
 * Background color adapts to terminal capability: TrueColor RGB (45, 49, 58) when the
 * terminal advertises 24-bit color support, 256-color slate (237) as fallback.
 */
export function formatUserMessage(message: string, cols?: number): string {
  const terminalCols = Math.max(cols ?? (process.stdout.columns || 80), 40);
  const truecolor = /truecolor|24bit/i.test(process.env.COLORTERM ?? "");
  const bg = truecolor ? "\x1b[48;2;45;49;58m" : "\x1b[48;5;237m";
  const fgPrompt = "\x1b[36m\x1b[1m"; // cyan bold '>'
  const fgText = "\x1b[97m\x1b[1m";   // bold bright white
  const reset = "\x1b[0m";

  const lines = message.split("\n");
  return lines
    .map((line, idx) => {
      const prefix = idx === 0 ? " > " : "   ";
      const prefixStyled = idx === 0 ? `${fgPrompt}${prefix}` : prefix;
      const textStyled = `${fgText}${line}`;
      const visibleLength = stringWidth(prefix + line);
      const padLength = Math.max(0, terminalCols - visibleLength);
      const padding = " ".repeat(padLength);
      return `${bg}${prefixStyled}${textStyled}${padding}${reset}`;
    })
    .join("\n");
}

/**
 * Renders the user's prompt as a full-width dark background bar — Claude Code style.
 * Erases the readline echo block (prompt + typed input, which may wrap over
 * multiple lines for long inputs) so the message only appears once, replacing
 * the raw input with the styled bar.
 *
 * @param echo Optional echo details: the raw readline prompt and the raw typed
 *             input. Defaults are derived from `message`.
 */
export function printUserMessage(
  message: string,
  echo?: { prompt?: string; input?: string },
): void {
  if (process.stdout.isTTY) {
    // After Enter the cursor sits on the line following the echo block, so
    // move up by the full wrapped line count and clear down to erase it all.
    const cols = process.stdout.columns || 80;
    const lines = echoLineCount(echo?.prompt ?? "▲ > ", echo?.input ?? message, cols);
    readline.moveCursor(process.stdout, 0, -lines);
    readline.clearScreenDown(process.stdout);
  }

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

export const terracotta = (s: string) => `\x1b[38;2;227;100;70m${s}\x1b[0m`;
export const claudeAmber = (s: string) => `\x1b[38;2;217;119;6m${s}\x1b[0m`;

/**
 * Point 7: Floating "Jump to bottom (Ctrl+End) ↓" badge shown when scrolling or viewing long output.
 */
export function renderJumpToBottomBadge(cols?: number): string {
  const terminalCols = Math.max(cols ?? (process.stdout?.columns || 80), 40);
  const text = " Jump to bottom (Ctrl+End) ↓ ";
  const textStyled = `\x1b[7m\x1b[1m${text}\x1b[0m`;
  const visibleLen = stringWidth(text);
  const leftPad = Math.max(0, Math.floor((terminalCols - visibleLen) / 2));
  return `${" ".repeat(leftPad)}${textStyled}`;
}

export interface StatusDockOptions {
  mode?: "manual" | "auto" | "plan";
  isRunning?: boolean;
  cols?: number;
}

/**
 * Point 8: Bottom status dock row:
 *   [•] manual mode on · ? for shortcuts · + for agents
 *   [•] manual mode on · esc to interrupt · + for agents
 */
export function renderStatusDock(options: StatusDockOptions = {}): string {
  const mode = options.mode ?? "manual";
  const isRunning = options.isRunning ?? false;

  const modeBadge =
    mode === "plan"
      ? `${pc.cyan("[")}${pc.bold(pc.cyan("•"))}${pc.cyan("]")} ${pc.bold(pc.cyan("plan mode on"))}`
      : `${pc.cyan("[")}${pc.bold(pc.cyan("•"))}${pc.cyan("]")} ${pc.bold("manual mode on")}`;

  const hints: string[] = [];
  if (isRunning) {
    hints.push(pc.dim("esc to interrupt"));
    hints.push(pc.dim("+ for agents"));
  } else {
    hints.push(pc.dim("? for shortcuts"));
    hints.push(pc.dim("+ for agents"));
  }

  return `${modeBadge}  ${hints.join(pc.dim(" · "))}`;
}
