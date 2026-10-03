import { safeGitArgs } from "../utils/safeGit.js";
import { atomicJson } from "./store.js";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { Semaphore } from "./tasks.js";
import type { VerificationRecord } from "./contracts.js";
const exec = promisify(execFile);
const EXCLUDED = new Set([
  ".git",
  ".codeagent",
  "node_modules",
  "dist",
  "build",
  ".cache",
  ".venv",
  "__pycache__",
  "coverage",
]);
export interface WorkspaceState {
  hash: string;
  files: Record<string, string>;
}
export async function git(
  root: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  return (
    await exec("git", await safeGitArgs(root, args), {
      cwd: root,
      env: env ?? process.env,
      maxBuffer: 32 * 1024 * 1024,
    })
  ).stdout;
}
export async function isGit(root: string): Promise<boolean> {
  try {
    await git(root, ["rev-parse", "--show-toplevel"]);
    return true;
  } catch {
    return false;
  }
}
export type WorkspaceHashCache = Map<string, { fingerprint: string; hash: string }>;
export async function workspaceState(
  root: string,
  cache?: WorkspaceHashCache,
): Promise<WorkspaceState> {
  let names: string[];
  if (await isGit(root))
    names = [
      ...new Set(
        (await git(root, ["ls-files", "-co", "--exclude-standard", "-z"]))
          .split("\0")
          .filter(Boolean),
      ),
    ];
  else {
    names = [];
    async function walk(dir: string): Promise<void> {
      for (const e of await fs.readdir(path.join(root, dir), {
        withFileTypes: true,
      })) {
        if (EXCLUDED.has(e.name)) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) await walk(p);
        else names.push(p);
      }
    }
    await walk("");
  }
  const files: Record<string, string> = {};
  for (const name of names.sort()) {
    if (name.split(/[\\/]/).some((p) => EXCLUDED.has(p))) continue;
    try {
      const file = path.resolve(root, name);
      const stat = await fs.lstat(file, { bigint: true });
      const fingerprint = [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
      const cached = cache?.get(file);
      if (cached?.fingerprint === fingerprint) {
        files[name] = cached.hash;
        continue;
      }
      const bytes = stat.isSymbolicLink()
        ? Buffer.from(await fs.readlink(path.join(root, name)))
        : await fs.readFile(path.join(root, name));
      files[name] = createHash("sha256")
        .update(String(stat.mode))
        .update(bytes)
        .digest("hex");
      cache?.set(file, { fingerprint, hash: files[name]! });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  if (cache) {
    const present = new Set(Object.keys(files).map((name) => path.resolve(root, name)));
    for (const file of cache.keys()) if (!present.has(file)) cache.delete(file);
  }
  return {
    files,
    hash: createHash("sha256").update(JSON.stringify(files)).digest("hex"),
  };
}
export function changedFiles(a: WorkspaceState, b: WorkspaceState): string[] {
  return [
    ...new Set([...Object.keys(a.files), ...Object.keys(b.files)]),
  ].filter((p) => a.files[p] !== b.files[p]);
}
export async function discoverChecks(root: string): Promise<string[]> {
  try {
    const pkg = JSON.parse(
      await fs.readFile(path.join(root, "package.json"), "utf8"),
    ) as { scripts?: Record<string, string> };
    const scripts = pkg.scripts ?? {};
    const pm = await fs.access(path.join(root, "pnpm-lock.yaml")).then(
      () => "pnpm",
      () =>
        fs.access(path.join(root, "yarn.lock")).then(
          () => "yarn",
          () => "npm",
        ),
    );
    const commands = ["test", "typecheck", "lint", "build"]
      .filter(
        (k) =>
          scripts[k] &&
          !/no test specified|echo\s+["']?(?:ok|pass)/i.test(scripts[k]),
      )
      .map((k) => `${pm} run ${k}`);
    if (commands.length) return commands;
  } catch {
    /* other ecosystems */
  }
  for (const [file, cmd] of [
    ["Cargo.toml", "cargo test"],
    ["go.mod", "go test ./..."],
    ["pyproject.toml", "python -m pytest"],
    ["pytest.ini", "python -m pytest"],
    ["Makefile", "make test"],
  ]) {
    if (
      await fs.access(path.join(root, file)).then(
        () => true,
        () => false,
      )
    )
      return [cmd];
  }
  const files = Object.keys((await workspaceState(root)).files);
  if (files.some((f) => /\.(test|spec)\.[cm]?js$/.test(f)))
    return ["node --test"];
  if (files.some((f) => /(^|\/)test_[^/]+\.py$/.test(f)))
    return ["python -m pytest"];
  if (files.some((f) => f.endsWith("_test.go"))) return ["go test ./..."];
  return [];
}
export class VerificationLedger {
  constructor(public records: VerificationRecord[] = []) {}
  record(
    command: string,
    exitCode: number,
    output: string,
    workspaceHash: string,
    artifact?: string,
  ): VerificationRecord {
    const r = {
      id: randomUUID(),
      command,
      exitCode,
      output,
      workspaceHash,
      artifact,
      timestamp: new Date().toISOString(),
      valid: true,
    };
    this.records.push(r);
    return r;
  }
  refresh(hash: string): void {
    for (const r of this.records) r.valid = r.workspaceHash === hash;
  }
  missing(required: string[], hash: string): string[] {
    this.refresh(hash);
    return required.filter((cmd) => {
      const last = this.records
        .filter((r) => r.command === cmd && r.valid)
        .at(-1);
      return !last || last.exitCode !== 0;
    });
  }
}
/** Snapshot uses a temporary index; neither the user's index nor branch moves. */
export async function snapshotCommit(
  root: string,
  tempDir: string,
): Promise<string> {
  await fs.mkdir(tempDir, { recursive: true });
  const index = path.join(tempDir, `index-${randomUUID()}`);
  const env = {
    ...process.env,
    GIT_INDEX_FILE: index,
    GIT_AUTHOR_NAME: "CodeAgent",
    GIT_AUTHOR_EMAIL: "local@codeagent.invalid",
    GIT_COMMITTER_NAME: "CodeAgent",
    GIT_COMMITTER_EMAIL: "local@codeagent.invalid",
  };
  try {
    let parent: string | undefined;
    try {
      parent = (await git(root, ["rev-parse", "HEAD"])).trim();
      await git(root, ["read-tree", parent], env);
    } catch {
      await git(root, ["read-tree", "--empty"], env);
    }
    await git(root, ["add", "-A", "--", "."], env);
    const tree = (await git(root, ["write-tree"], env)).trim();
    return (
      await git(
        root,
        [
          "commit-tree",
          tree,
          ...(parent ? ["-p", parent] : []),
          "-m",
          "CodeAgent workspace snapshot",
        ],
        env,
      )
    ).trim();
  } finally {
    await fs.rm(index, { force: true });
  }
}
export async function applyPatch(
  root: string,
  patch: string,
  check = false,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const p = spawn(
      "git",
      ["apply", ...(check ? ["--check"] : []), "--binary", "-"],
      { cwd: root },
    );
    let err = "";
    p.stderr.on("data", (d) => (err += String(d)));
    p.on("error", reject);
    p.on("close", (c) => (c === 0 ? resolve() : reject(new Error(err))));
    p.stdin.on("error", reject);
    p.stdin.end(patch);
  });
}
export class WorktreeCoordinator {
  private lock = new Semaphore(1);
  private integratedBase?: string;
  private base?: string;
  private expected?: WorkspaceState;
  private integration?: string;
  private workers = new Map<string, string>();
  private verified = new Map<string, string>();
  constructor(
    private root: string,
    private directory: string,
  ) {}
  async restore(): Promise<void> {
    try {
      const state = JSON.parse(
        await fs.readFile(path.join(this.directory, "worktrees.json"), "utf8"),
      );
      this.base = state.base;
      this.integratedBase = state.integratedBase;
      this.integration = state.integration;
      this.expected = state.expected;
      this.workers = new Map(state.workers);
      this.verified = new Map(state.verified ?? []);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  private persist(): void {
    atomicJson(path.join(this.directory, "worktrees.json"), {
      base: this.base,
      integratedBase: this.integratedBase,
      integration: this.integration,
      expected: this.expected,
      workers: [...this.workers],
      verified: [...this.verified],
    });
  }
  async cleanup(id: string): Promise<void> {
    await this.lock.run(async () => {
      const worker = this.workers.get(id),
        tested = this.verified.get(id);
      if (!worker || !tested || (await workspaceState(worker)).hash !== tested)
        return;
      // The integration commit retains these exact changes, including originally dirty files.
      await git(this.root, ["worktree", "remove", "--force", worker]);
      this.workers.delete(id);
      this.verified.delete(id);
      this.persist();
    });
  }

  async create(id: string): Promise<string> {
    return this.lock.run(() => this.createLocked(id));
  }
  private async createLocked(id: string): Promise<string> {
    if (!this.base) {
      this.expected = await workspaceState(this.root);
      this.base = await snapshotCommit(this.root, this.directory);
      this.integration = path.join(this.directory, "integration");
      await git(this.root, [
        "worktree",
        "add",
        "--detach",
        this.integration,
        this.base,
      ]);
    }
    const dir = path.join(this.directory, `worker-${id}`);
    await git(this.root, ["worktree", "add", "--detach", dir, this.base]);
    this.workers.set(id, dir);
    this.persist();
    return dir;
  }
  async integrate(
    id: string,
    authorize: (files: string[]) => Promise<void>,
    verify: (root: string) => Promise<void>,
  ): Promise<string[]> {
    return this.lock.run(() => this.integrateLocked(id, authorize, verify));
  }
  private async integrateLocked(
    id: string,
    authorize: (files: string[]) => Promise<void>,
    verify: (root: string) => Promise<void>,
  ): Promise<string[]> {
    const worker = this.workers.get(id);
    if (!worker || !this.base || !this.integration || !this.expected)
      throw new Error("Unknown worker");
    if ((await workspaceState(this.root)).hash !== this.expected.hash)
      throw new Error(
        "Destination changed; worker result retained for reconciliation",
      );
    const workerState = await workspaceState(worker);
    const commit = await snapshotCommit(worker, this.directory);
    if ((await workspaceState(worker)).hash !== workerState.hash)
      throw new Error(
        "Worker changed while capturing its result; retry after it stops",
      );
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: "CodeAgent",
      GIT_AUTHOR_EMAIL: "local@codeagent.invalid",
      GIT_COMMITTER_NAME: "CodeAgent",
      GIT_COMMITTER_EMAIL: "local@codeagent.invalid",
    };
    try {
      await git(
        this.integration,
        [
          "-c",
          `core.hooksPath=${path.join(this.directory, "empty-hooks")}`,
          "merge",
          "--no-edit",
          commit,
        ],
        env,
      );
    } catch {
      await git(this.integration, ["merge", "--abort"]).catch(() => {});
      throw new Error("Integration conflict; worker changes retained");
    }
    const files = (
      await git(this.integration, [
        "diff",
        "--name-only",
        this.integratedBase ?? this.base,
        "HEAD",
        "-z",
      ])
    )
      .split("\0")
      .filter(Boolean);
    await authorize(files);
    const tested = await workspaceState(this.integration);
    await verify(this.integration);
    if ((await workspaceState(this.integration)).hash !== tested.hash)
      throw new Error(
        "Verification changed the integration workspace; inspect retained changes before retrying",
      );
    if ((await workspaceState(this.root)).hash !== this.expected.hash)
      throw new Error(
        "Destination changed during verification; integration retained",
      );
    const patch = await git(this.integration, [
      "diff",
      "--binary",
      this.integratedBase ?? this.base,
      "HEAD",
    ]);
    if (patch) {
      await applyPatch(this.root, patch, true);
      await applyPatch(this.root, patch);
    }
    this.expected = await workspaceState(this.root);
    this.integratedBase = (
      await git(this.integration, ["rev-parse", "HEAD"])
    ).trim();
    this.verified.set(id, workerState.hash);
    this.persist();
    return files;
  }
}

export interface FileCheckpoint {
  root: string;
  before: WorkspaceState;
  after?: WorkspaceState;
  directory: string;
}
export async function createFileCheckpoint(
  root: string,
  directory: string,
): Promise<FileCheckpoint> {
  const before = await workspaceState(root);
  await fs.mkdir(path.join(directory, "files"), {
    recursive: true,
    mode: 0o700,
  });
  for (const name of Object.keys(before.files)) {
    const source = path.join(root, name),
      target = path.join(directory, "files", name);
    const stat = await fs.lstat(source);
    if (stat.isSymbolicLink()) continue;
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(source, target);
    await fs.chmod(target, stat.mode);
  }
  const checkpoint = { root, before, directory };
  await fs.writeFile(
    path.join(directory, "manifest.json"),
    JSON.stringify(checkpoint),
    { mode: 0o600 },
  );
  return checkpoint;
}
export async function finishFileCheckpoint(
  checkpoint: FileCheckpoint,
): Promise<void> {
  checkpoint.after = await workspaceState(checkpoint.root);
  await fs.writeFile(
    path.join(checkpoint.directory, "manifest.json"),
    JSON.stringify(checkpoint),
    { mode: 0o600 },
  );
}
export async function restoreFileCheckpoint(
  checkpoint: FileCheckpoint,
  authorize: (files: string[]) => Promise<void>,
): Promise<string[]> {
  if (!checkpoint.after)
    throw new Error("Interrupted checkpoint requires manual reconciliation");
  const current = await workspaceState(checkpoint.root);
  const changed = changedFiles(checkpoint.before, checkpoint.after);
  for (const name of changed) {
    if (current.files[name] !== checkpoint.after.files[name])
      throw new Error(`User changes detected in ${name}; refusing rollback`);
  }
  await authorize(changed);
  // Validate every target before any write, including symlink parents.
  for (const name of changed) {
    let parent = path.dirname(path.join(checkpoint.root, name));
    while (parent !== checkpoint.root) {
      try {
        if ((await fs.lstat(parent)).isSymbolicLink())
          throw new Error("Rollback path traverses a symlink");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      parent = path.dirname(parent);
    }
  }
  for (const name of changed) {
    const target = path.join(checkpoint.root, name);
    if (checkpoint.before.files[name]) {
      const source = path.join(checkpoint.directory, "files", name);
      await fs.access(source);
    } else {
      await fs.access(target).catch(() => {});
    }
  }
  for (const name of changed) {
    const target = path.join(checkpoint.root, name);
    await fs.rm(target, { force: true });
    if (checkpoint.before.files[name]) {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(path.join(checkpoint.directory, "files", name), target);
    }
  }
  return changed;
}
