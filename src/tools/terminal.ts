import { exec } from "node:child_process";
import { promisify } from "node:util";
import { TRUNCATION_BUDGETS, truncate } from "../utils/truncate.js";

const execAsync = promisify(exec);

export const COMMAND_TIMEOUT_MS = 120_000;

/**
 * Blocklist for obviously destructive commands. This is a shallow
 * defense-in-depth check — NOT a sandbox. Treat the terminal tool as
 * DEV-ONLY until it runs inside a Docker/VM sandbox (see CommandRunner).
 */
const BLOCKED_PATTERNS = [
  /\bsudo\b/i,
  /rm\s+-rf\s+\/(?!\S)/, // rm -rf /
  /rm\s+-rf\s+~/, // rm -rf ~
  /\bmkfs\b/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\bhalt\b/i,
  /:\(\)\s*{\s*:\s*|\s*:\s*&\s*}\s*;/, // fork bomb
  /\bdiskpart\b/i,
  /format\s+[a-z]:/i,
];

/** Structured result so callers can distinguish failure from output. */
export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  combined: string;
}

/**
 * Abstraction boundary for future sandboxed execution.
 * The agent depends on this interface, not on exec() directly.
 * A Docker/VM implementation can replace DevLocalCommandRunner later
 * without touching agent or tool-registry code.
 */
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
      // Deliberately no custom `shell`: Node uses cmd.exe on Windows and
      // /bin/sh on POSIX. Verified 2026-09: routing through PowerShell
      // mangles quotes/parens for native commands (e.g. node -e "..."
      // arrives as an empty script). cmd's gaps (`;` separator, no
      // tail/head) are covered by OS-specific guidance in the agent
      // context instead — a faithful shell beats a featureful one.
      const { stdout, stderr } = await execAsync(normalized, {
        cwd: repoRoot,
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer: 2 * 1024 * 1024,
        signal,
        windowsHide: true,
      });
      const combined = [stdout, stderr].filter(Boolean).join("\n");
      return {
        exitCode: 0,
        stdout: truncate(stdout, TRUNCATION_BUDGETS.terminal),
        stderr: truncate(stderr, TRUNCATION_BUDGETS.terminal),
        combined: truncate(combined, TRUNCATION_BUDGETS.terminal),
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
      // exec() rejects on non-zero exit — still return the output.
      if (typeof err.code === "number") {
        const stdout = String(err.stdout ?? "");
        const stderr = String(err.stderr ?? "");
        const combined = [stdout, stderr, `exit code: ${err.code}`].filter(Boolean).join("\n");
        return {
          exitCode: err.code,
          stdout: truncate(stdout, TRUNCATION_BUDGETS.terminal),
          stderr: truncate(stderr, TRUNCATION_BUDGETS.terminal),
          combined: truncate(combined, TRUNCATION_BUDGETS.terminal),
        };
      }
      throw new Error(`Command failed: ${err.message ?? String(error)}`);
    }
  }
}

const defaultRunner = new DevLocalCommandRunner();

/** MVP entry point used by the tool registry. */
export async function runCommand(
  repoRoot: string,
  command: string,
  signal?: AbortSignal,
  runner: CommandRunner = defaultRunner,
): Promise<string> {
  // Never leak env secrets into model-visible output.
  const result = await runner.run(repoRoot, command, signal);
  const header = `exit code: ${result.exitCode}`;
  if (!result.combined) return header;
  return `${header}\n${result.combined}`;
}
