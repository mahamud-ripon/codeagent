import { buildRepoMap } from "../repo/scanner.js";
import { formatMemoryForContext, formatRulesForContext, type LoadedRule } from "./rules.js";

function environmentBlock(): string {
  const platform = process.platform; // win32 | darwin | linux
  const windowsNotes =
    platform === "win32"
      ? [
          "You are on Windows. Commands run under cmd.exe, NOT bash or PowerShell:",
          "- Chain commands with `&` (always) or `&&` (on success). `;` is NOT a separator and will fail.",
          "- `2>&1` works. `||` works.",
          "- NO tail/head/grep/awk/sed/wc — they do not exist. `findstr` works like grep, `more` pages output.",
          "- Do NOT pipe to tail/head to limit output: tool output is already truncated to 30k chars for you.",
          "- Prefer one command per run_command call. `npm test` over `npm test 2>&1 | tail -50`.",
        ].join("\n")
      : [
          `You are on ${platform}. Commands run under /bin/sh from the repo root.`,
          "Prefer POSIX tools (head/tail/grep) for narrowing output; output is truncated for you anyway.",
        ].join("\n");
  const shell = platform === "win32" ? "cmd.exe" : "/bin/sh";
  return ["<environment>", `OS: ${platform} | shell: ${shell}`, windowsNotes, "</environment>"].join("\n");
}

/**
 * Build the one-shot context injected before the user request:
 * repo map + scripts + phase-0 guidance + project rules. Everything else is
 * retrieved progressively via tools (never dump the whole repo).
 * AG-16: when a task query is provided, a ranked top-files section focuses
 * the model on likely-relevant paths instead of the flat 2,000-file list.
 * EX-4: skill descriptions are always in context; bodies load on demand.
 */
export async function buildInitialContext(
  repoRoot: string,
  rules: LoadedRule[] = [],
  memory: LoadedRule[] = [],
  query?: string,
): Promise<string> {
  const map = await buildRepoMap(repoRoot);
  const lines = [
    "<repository>",
    map.summary,
    `Total files indexed: ${map.totalFiles}${map.truncated ? " (list truncated at 2000)" : ""}`,
    "</repository>",
    "",
    environmentBlock(),
    "",
    "Follow the EXPLORE -> IMPLEMENT -> VERIFY -> REVIEW workflow from the system prompt.",
  ];

  // Ranked focus (AG-16): cheap term-overlap scoring, no native deps.
  if (query?.trim()) {
    try {
      const { rankedRepoMap } = await import("../repo/rankedMap.js");
      const files = map.files.split("\n").filter(Boolean).slice(0, 2000).map((p) => ({ path: p, sizeKb: 10 }));
      const top = await rankedRepoMap(repoRoot, query, files, 30);
      if (top.length > 0) {
        lines.push("", `<ranked_files query="${query.slice(0, 120).replace(/"/g, "")}">`);
        for (const f of top.slice(0, 30)) lines.push(`- ${f.path} (score ${f.score})`);
        lines.push("</ranked_files>");
      }
    } catch {
      // ranked map is best-effort; flat map above still applies
    }
  }

  if (memory.length > 0) {
    lines.push("");
    lines.push(formatMemoryForContext(memory));
  }

  if (rules.length > 0) {
    lines.push("");
    lines.push(formatRulesForContext(rules));
  }

  // Skills (EX-4): descriptions always in context.
  try {
    const { loadSkills, skillContextBlock } = await import("./skills.js");
    const skills = await loadSkills(repoRoot);
    const block = skillContextBlock(skills);
    if (block) {
      lines.push("");
      lines.push(block);
    }
  } catch {
    // skills are best-effort
  }

  return lines.join("\n");
}
