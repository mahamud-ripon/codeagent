import {
  type CommandResult,
  type CommandRunner,
  DevLocalCommandRunner,
  COMMAND_TIMEOUT_MS,
  BLOCKED_PATTERNS,
} from "./runner.js";
import { getActiveCommandRunner } from "./sandbox.js";

// Re-export for existing consumers and tests
export {
  type CommandResult,
  type CommandRunner,
  DevLocalCommandRunner,
  COMMAND_TIMEOUT_MS,
  BLOCKED_PATTERNS,
};

/** MVP entry point used by the tool registry. */
export async function runCommand(
  repoRoot: string,
  command: string,
  signal?: AbortSignal,
  runner?: CommandRunner,
): Promise<string> {
  const active = runner ?? getActiveCommandRunner();
  // Never leak env secrets into model-visible output.
  const result = await active.run(repoRoot, command, signal);
  const header = `exit code: ${result.exitCode}`;
  if (!result.combined) return header;
  return `${header}\n${result.combined}`;
}
