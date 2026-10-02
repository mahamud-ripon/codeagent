import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
/** Internal bookkeeping must not execute repository-configured programs. */
export async function safeGitArgs(
  root: string,
  args: string[],
): Promise<string[]> {
  const policy = [
    "-c",
    `core.hooksPath=${os.devNull}`,
    "-c",
    "core.fsmonitor=false",
    "-c",
    "diff.external=",
    "-c",
    "commit.gpgSign=false",
  ];
  let names = "";
  try {
    names = (
      await exec(
        "git",
        [
          ...policy,
          "config",
          "--name-only",
          "--get-regexp",
          "^(filter\\..*\\.(clean|smudge|process|required)|merge\\..*\\.driver)$",
        ],
        { cwd: root, timeout: 5000 },
      )
    ).stdout;
  } catch (error) {
    if ((error as { code?: number }).code !== 1) throw error;
  }
  for (const key of names.trim().split(/\r?\n/).filter(Boolean))
    policy.push(
      "-c",
      `${key}=${key.endsWith(".required") || key.startsWith("merge.") ? "false" : ""}`,
    );
  return [
    ...policy,
    ...args,
    ...(args[0] === "diff" ? ["--no-textconv", "--no-ext-diff"] : []),
  ];
}
