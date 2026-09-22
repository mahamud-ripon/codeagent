import { z } from "zod";
import { listFiles, readFile, writeFile, editFile } from "./filesystem.js";
import { search } from "./search.js";
import { runCommand } from "./terminal.js";
import { gitStatus, gitDiff } from "./git.js";

const listFilesSchema = z.object({ path: z.string().optional().default(".") });
const readFileSchema = z.object({ path: z.string().min(1) });
const writeFileSchema = z.object({ path: z.string().min(1), content: z.string() });
const editFileSchema = z.object({
  path: z.string().min(1),
  old_text: z.string().min(1),
  new_text: z.string(),
});
const searchSchema = z.object({ query: z.string().min(1) });
const runCommandSchema = z.object({ command: z.string().min(1) });
const emptySchema = z.object({}).passthrough();

export type ToolName =
  | "list_files"
  | "read_file"
  | "write_file"
  | "edit_file"
  | "search"
  | "run_command"
  | "git_status"
  | "git_diff";

function parseArgs<T>(schema: z.ZodType<T>, args: Record<string, unknown>, tool: string): T {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    throw new Error(`Invalid arguments for ${tool}: ${parsed.error.message}`);
  }
  return parsed.data;
}

/**
 * Single dispatch point for all agent tool calls.
 * Validates args with Zod so malformed model output becomes a
 * recoverable TOOL ERROR instead of a crash.
 */
export async function executeTool(
  repoRoot: string,
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<string> {
  switch (name as ToolName) {
    case "list_files": {
      const a = parseArgs(listFilesSchema, args, name);
      return listFiles(repoRoot, a.path);
    }
    case "read_file": {
      const a = parseArgs(readFileSchema, args, name);
      return readFile(repoRoot, a.path);
    }
    case "write_file": {
      const a = parseArgs(writeFileSchema, args, name);
      return writeFile(repoRoot, a.path, a.content);
    }
    case "edit_file": {
      const a = parseArgs(editFileSchema, args, name);
      return editFile(repoRoot, a.path, a.old_text, a.new_text);
    }
    case "search": {
      const a = parseArgs(searchSchema, args, name);
      return search(repoRoot, a.query);
    }
    case "run_command": {
      const a = parseArgs(runCommandSchema, args, name);
      return runCommand(repoRoot, a.command, signal);
    }
    case "git_status": {
      parseArgs(emptySchema, args, name);
      return gitStatus(repoRoot);
    }
    case "git_diff": {
      parseArgs(emptySchema, args, name);
      return gitDiff(repoRoot);
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
