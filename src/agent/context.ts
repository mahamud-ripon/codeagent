import { buildRepoMap } from "../repo/scanner.js";

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
 * repo map + scripts + phase-0 guidance. Everything else is
 * retrieved progressively via tools (never dump the whole repo).
 */
export async function buildInitialContext(repoRoot: string): Promise<string> {
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
  return lines.join("\n");
}
