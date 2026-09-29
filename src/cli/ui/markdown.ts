import { pc } from "./theme.js";

/**
 * Format markdown text for rich display in the terminal with ANSI colors.
 */
export function formatMarkdown(text: string): string {
  if (!text) return "";

  const lines = text.split("\n");
  const formatted: string[] = [];
  let inCodeBlock = false;
  let codeBlockLang = "";
  let codeBlockLines: string[] = [];

  // Frame width adapts to the terminal (capped at 80, floored at 40).
  const frameWidth = Math.max(40, Math.min(process.stdout.columns || 80, 80));
  const renderCodeBlock = (lang: string, blockLines: string[]): string[] => {
    const header =
      pc.dim(`╭── ${pc.bold(pc.cyan(lang))} `) +
      pc.dim("─".repeat(Math.max(3, frameWidth - 5 - lang.length)));
    const out = [header];
    for (const cl of blockLines) {
      out.push(`${pc.dim("│")}  ${highlightCodeLine(cl, lang)}`);
    }
    out.push(pc.dim("╰" + "─".repeat(frameWidth - 1)));
    return out;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Code block delimiters: ```lang
    if (line.trim().startsWith("```")) {
      if (!inCodeBlock) {
        inCodeBlock = true;
        codeBlockLang = line.trim().slice(3).trim() || "code";
        codeBlockLines = [];
        continue;
      } else {
        inCodeBlock = false;
        formatted.push(...renderCodeBlock(codeBlockLang, codeBlockLines));
        continue;
      }
    }

    if (inCodeBlock) {
      codeBlockLines.push(line);
      continue;
    }

    // Markdown Headers
    if (line.startsWith("# ")) {
      formatted.push("");
      formatted.push(pc.bold(pc.cyan(`━━━ ${line.slice(2).trim()} ━━━`)));
      continue;
    }
    if (line.startsWith("## ")) {
      formatted.push("");
      formatted.push(pc.bold(pc.cyan(`■ ${line.slice(3).trim()}`)));
      continue;
    }
    if (line.startsWith("### ")) {
      formatted.push("");
      formatted.push(pc.bold(pc.white(`▶ ${line.slice(4).trim()}`)));
      continue;
    }

    // Blockquotes
    if (line.startsWith("> ")) {
      formatted.push(`  ${pc.dim("│")} ${pc.italic(line.slice(2))}`);
      continue;
    }

    // Bullet Lists
    if (/^\s*[-*]\s+/.test(line)) {
      const indent = line.match(/^\s*/)?.[0] ?? "";
      const content = line.replace(/^\s*[-*]\s+/, "");
      formatted.push(`${indent}  ${pc.cyan("•")} ${formatInline(content)}`);
      continue;
    }

    // Numbered Lists
    if (/^\s*\d+\.\s+/.test(line)) {
      const match = line.match(/^(\s*)(\d+\.)\s+(.*)/);
      if (match) {
        formatted.push(`${match[1]}  ${pc.bold(match[2])} ${formatInline(match[3])}`);
        continue;
      }
    }

    // Horizontal Rule
    if (/^---+$|^\*\*\*+$/.test(line.trim())) {
      formatted.push(pc.dim("─".repeat(55)));
      continue;
    }

    // Standard text line
    formatted.push(formatInline(line));
  }

  // Handle unclosed code block if response was truncated
  if (inCodeBlock && codeBlockLines.length > 0) {
    formatted.push(...renderCodeBlock(codeBlockLang, codeBlockLines));
  }

  return formatted.join("\n");
}

/**
 * Format inline markdown tokens: `code`, **bold**, *italic*.
 */
function formatInline(str: string): string {
  // `inline code`
  let res = str.replace(/`([^`]+)`/g, (_, code) => pc.yellow(code));

  // **bold**
  res = res.replace(/\*\*([^*]+)\*\*/g, (_, bold) => pc.bold(bold));

  // *italic*
  res = res.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, (_, it) => pc.italic(it));

  return res;
}

/**
 * Lightweight syntax highlighting for code lines inside code blocks.
 */
function highlightCodeLine(line: string, _lang: string): string {
  // Comments
  if (/^\s*\/\//.test(line) || /^\s*#/.test(line)) {
    return pc.dim(line);
  }

  // Strings (quoted): mask them with placeholders so the keyword pass
  // below never recolors keywords that appear inside string literals.
  const stringTokens: string[] = [];
  let highlighted = line.replace(/(["'`])(?:(?=(\\?))\2.)*?\1/g, (m) => {
    stringTokens.push(pc.green(m));
    return `\u0000${stringTokens.length - 1}\u0000`;
  });

  // Common keywords
  const keywords = [
    "const", "let", "var", "function", "return", "import", "export", "from",
    "if", "else", "switch", "case", "for", "while", "class", "extends",
    "async", "await", "try", "catch", "throw", "new", "type", "interface",
    "def", "self", "None", "True", "False", "as",
  ];
  const kwRegex = new RegExp(`\\b(${keywords.join("|")})\\b`, "g");
  highlighted = highlighted.replace(kwRegex, (m) => pc.magenta(m));

  // Restore the green string literals.
  highlighted = highlighted.replace(/\u0000(\d+)\u0000/g, (_, i: string) => stringTokens[Number(i)]);
  return highlighted;
}

/**
 * Colorizes a unified diff with green additions, red deletions, and cyan chunk headers.
 */
export function formatDiff(diffText: string): string {
  if (!diffText.trim()) return pc.dim("(no changes)");

  const lines = diffText.split("\n");
  const formatted: string[] = [];

  for (const line of lines) {
    if (line.startsWith("diff --git") || line.startsWith("index ")) {
      formatted.push(pc.dim(line));
    } else if (line.startsWith("--- ") || line.startsWith("+++ ")) {
      formatted.push(pc.bold(line));
    } else if (line.startsWith("@@")) {
      formatted.push(pc.cyan(line));
    } else if (line.startsWith("+")) {
      formatted.push(pc.green(line));
    } else if (line.startsWith("-")) {
      formatted.push(pc.red(line));
    } else {
      formatted.push(pc.dim(" ") + line.slice(1));
    }
  }

  return formatted.join("\n");
}
