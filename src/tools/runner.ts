import { exec } from "node:child_process";
import { promisify } from "node:util";
import { TRUNCATION_BUDGETS, truncate } from "../utils/truncate.js";

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

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  combined: string;
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
