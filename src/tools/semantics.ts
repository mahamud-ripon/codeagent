/**
 * Command semantics configuration for interpreting exit codes in different contexts.
 *
 * Inspired by Claude Code's commandSemantics.ts:
 * Many commands use exit codes to convey information other than just success/failure.
 * For example, grep returns 1 when no matches are found, which is not an error condition.
 */

export interface CommandSemanticResult {
  isError: boolean;
  semanticMessage?: string;
  annotatedOutput?: string;
}

export type CommandSemantic = (
  exitCode: number,
  stdout: string,
  stderr: string,
) => CommandSemanticResult;

function extractBaseCommand(command: string): string {
  const trimmed = command.trim();
  // Strip environment variables if prefixed (e.g., "FOO=bar grep ...")
  const withoutEnv = trimmed.replace(/^([A-Za-z_][A-Za-z0-9_]*=\S+\s+)+/, "");
  // Take first word, handling quotes and paths (e.g. "/usr/bin/grep" or "grep.exe")
  const firstWord = withoutEnv.split(/\s+/)[0] ?? "";
  const baseName = firstWord.replace(/^.*[/\\]/, "").replace(/\.(exe|cmd|bat)$/i, "").toLowerCase();
  return baseName;
}

const COMMAND_SEMANTICS: Map<string, CommandSemantic> = new Map([
  // grep & ripgrep: 0=matches found, 1=no matches found, 2+=actual syntax/io error
  [
    "grep",
    (exitCode, stdout, stderr) => {
      if (exitCode === 1) {
        return {
          isError: false,
          semanticMessage: "No matches found",
          annotatedOutput: "(no matches found)",
        };
      }
      return {
        isError: exitCode >= 2,
        semanticMessage: exitCode >= 2 ? "grep error" : undefined,
      };
    },
  ],
  [
    "rg",
    (exitCode, stdout, stderr) => {
      if (exitCode === 1) {
        return {
          isError: false,
          semanticMessage: "No matches found",
          annotatedOutput: "(no matches found)",
        };
      }
      return {
        isError: exitCode >= 2,
        semanticMessage: exitCode >= 2 ? "ripgrep error" : undefined,
      };
    },
  ],
  [
    "ripgrep",
    (exitCode, stdout, stderr) => {
      if (exitCode === 1) {
        return {
          isError: false,
          semanticMessage: "No matches found",
          annotatedOutput: "(no matches found)",
        };
      }
      return {
        isError: exitCode >= 2,
        semanticMessage: exitCode >= 2 ? "ripgrep error" : undefined,
      };
    },
  ],
  // diff: 0=no differences, 1=differences found, 2+=error
  [
    "diff",
    (exitCode) => ({
      isError: exitCode >= 2,
      semanticMessage: exitCode === 1 ? "Differences found" : undefined,
    }),
  ],
  // find: 0=success, 1=some directories were inaccessible, 2+=error
  [
    "find",
    (exitCode) => ({
      isError: exitCode >= 2,
      semanticMessage: exitCode === 1 ? "Some directories were inaccessible" : undefined,
    }),
  ],
]);

/**
 * Phase 2 hygiene (emptySuccess): exit 0 + empty stdout from node/python
 * one-liners is a tool failure, not a durable green. Windows false greens:
 * multi-line `node -e` / `python -c` returned exit 0 with empty output and
 * silence was read as success. Label-only here; the caller decides whether
 * the hygiene flag treats it as failure (default off = historical behavior).
 */
export function isEmptyScriptSuccess(command: string, exitCode: number, stdout: string, stderr: string): boolean {
  if (exitCode !== 0) return false;
  const base = extractBaseCommand(command);
  if (base !== "node" && base !== "python" && base !== "python3") return false;
  const out = (stdout ?? "").trim();
  const err = (stderr ?? "").trim();
  if (out.length > 0 || err.length > 0) return false;
  // Only one-liner eval forms are suspect; a `node script.js` with no output
  // may legitimately be silent (e.g. a test file that only asserts).
  if (!/-(e|c)\b/.test(command)) return false;
  return true;
}

/**
 * Interprets command exit codes using semantic rules so that tools like grep
 * with 0 matches are recognized as normal operations rather than failures.
 */
export function interpretCommandResult(
  command: string,
  exitCode: number,
  stdout: string,
  stderr: string,
  hygieneOn = false,
): CommandSemanticResult {
  if (hygieneOn && isEmptyScriptSuccess(command, exitCode, stdout, stderr)) {
    return {
      isError: true,
      semanticMessage: "Empty inline script success",
      annotatedOutput:
        "TOOL FAILURE: `node -e` / `python -c` exited 0 with empty output. " +
        "Empty stdout is not proof of success — write a temp script file and run it instead.",
    };
  }
  const base = extractBaseCommand(command);
  const semantic = COMMAND_SEMANTICS.get(base);
  if (semantic) {
    return semantic(exitCode, stdout, stderr);
  }

  // Default: 0 is success, non-zero is error
  return {
    isError: exitCode !== 0,
    semanticMessage: exitCode !== 0 ? `Command exited with code ${exitCode}` : undefined,
  };
}
