import { exec } from "node:child_process";
import { promisify } from "node:util";
import { TRUNCATION_BUDGETS, truncate } from "../utils/truncate.js";
import { interpretCommandResult } from "./semantics.js";

const execAsync = promisify(exec);

export const COMMAND_TIMEOUT_MS = 120_000;

export const BLOCKED_PATTERNS = [
  /\bsudo\b/i,
  /rm\s+-rf\s+\/(?!\S)/,
  /rm\s+-rf\s+~/,
  /\bmkfs\b/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\bhalt\b/i,
  /:\(\)\s*{\s*:\s*|\s*:\s*&\s*}\s*;/,
  /\bdiskpart\b/i,
  /format\s+[a-z]:/i,
];

/**
 * Phase 2 hygiene (shellHint): multi-line `node -e` / `python -c` is
 * unreliable under cmd.exe via child_process.exec on Windows (not
 * PowerShell). When hygiene is on, return an error that tells the model to
 * write a temp script instead. Never silently rewrite bash.
 */
export function shellHintForCommand(command: string): string | null {
  if (!/\n/.test(command)) return null;
  if (!/\b(node(\.exe)?|python3?(\.exe)?)\s+.*-(e|c)\b/i.test(command)) return null;
  const platform = process.platform;
  const shell = platform === "win32" ? "cmd.exe via child_process.exec (not PowerShell)" : "/bin/sh";
  return (
    `Multi-line inline script detected (platform: ${platform}, shell: ${shell}). ` +
    `Do not use multi-line \`node -e\` / \`python -c\`: quoting fails here. ` +
    `Write a temp script file (e.g. write_file _eval_tmp.js) and run it with \`node\` / \`python\` instead.`
  );
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  combined: string;
  isError?: boolean;
  semanticMessage?: string;
}

export interface CommandRunner {
  run(repoRoot: string, command: string, signal?: AbortSignal): Promise<CommandResult>;
}

export class DevLocalCommandRunner implements CommandRunner {
  async run(repoRoot: string, command: string, signal?: AbortSignal): Promise<CommandResult> {
    const normalized = command.trim();
    if (!normalized) throw new Error("Command cannot be empty");
    if (normalized.length > 4000) throw new Error("Command too long (4000 char limit)");

    for (const pattern of BLOCKED_PATTERNS) {
      if (pattern.test(normalized)) {
        throw new Error(`Blocked potentially destructive command: ${command}`);
      }
    }

    try {
      const { stdout, stderr } = await execAsync(normalized, {
        cwd: repoRoot,
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer: 2 * 1024 * 1024,
        signal,
        windowsHide: true,
      });
      const semantic = interpretCommandResult(normalized, 0, stdout, stderr);
      const combined = [stdout, stderr, semantic.annotatedOutput].filter(Boolean).join("\n");
      return {
        exitCode: 0,
        stdout: truncate(stdout, TRUNCATION_BUDGETS.terminal),
        stderr: truncate(stderr, TRUNCATION_BUDGETS.terminal),
        combined: truncate(combined, TRUNCATION_BUDGETS.terminal),
        isError: semantic.isError,
        semanticMessage: semantic.semanticMessage,
      };
    } catch (error: unknown) {
      const err = error as {
        code?: number;
        killed?: boolean;
        stdout?: string;
        stderr?: string;
        message?: string;
      };
      if (err.killed) {
        throw new Error(`Command timed out after ${COMMAND_TIMEOUT_MS / 1000}s: ${command}`);
      }
      if (typeof err.code === "number") {
        const stdout = String(err.stdout ?? "");
        const stderr = String(err.stderr ?? "");
        const semantic = interpretCommandResult(normalized, err.code, stdout, stderr);
        const parts = [stdout, stderr];
        if (semantic.annotatedOutput && !parts.some((p) => p.includes(semantic.annotatedOutput!))) {
          parts.push(semantic.annotatedOutput);
        }
        parts.push(`exit code: ${err.code}`);
        const combined = parts.filter(Boolean).join("\n");
        return {
          exitCode: err.code,
          stdout: truncate(stdout, TRUNCATION_BUDGETS.terminal),
          stderr: truncate(stderr, TRUNCATION_BUDGETS.terminal),
          combined: truncate(combined, TRUNCATION_BUDGETS.terminal),
          isError: semantic.isError,
          semanticMessage: semantic.semanticMessage,
        };
      }
      throw new Error(`Command failed: ${err.message ?? String(error)}`);
    }
  }
}
