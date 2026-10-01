import { spawn, type ChildProcess } from "node:child_process";

/**
 * AG-14: spawn-based runner with streamed output, background jobs,
 * bash_output / kill_shell, process-tree kill, configurable timeout.
 * exec-based DevLocalCommandRunner stays the default for simple calls.
 */

export interface BgJob {
  id: string;
  command: string;
  output: string;
  done: boolean;
  exitCode?: number;
  startedAt: number;
  proc?: ChildProcess;
}

const jobs = new Map<string, BgJob>();
let counter = 0;

export function listBgJobs(): BgJob[] {
  return [...jobs.values()];
}

export function getBgJob(id: string): BgJob | undefined {
  return jobs.get(id);
}

function killTree(proc: ChildProcess | undefined): void {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
  if (proc.pid === undefined) return;
  try {
    if (process.platform === "win32") {
      const killer = spawn("taskkill", ["/pid", String(proc.pid), "/t", "/f"]);
      killer.on("error", () => undefined);
      killer.unref?.();
    } else {
      try { process.kill(-proc.pid, "SIGKILL"); } catch { proc.kill("SIGKILL"); }
    }
  } catch {
    try { proc.kill("SIGKILL"); } catch { /* best effort */ }
  }
}

const MAX_JOB_OUTPUT_CHARS = 256_000;
const MAX_BG_JOBS = 20;

function appendCapped(current: string, chunk: string): string {
  const next = current + chunk;
  if (next.length <= MAX_JOB_OUTPUT_CHARS) return next;
  return next.slice(next.length - MAX_JOB_OUTPUT_CHARS);
}

function evictOldJobs(): void {
  if (jobs.size < MAX_BG_JOBS) return;
  for (const [id, job] of jobs) {
    if (job.done) {
      jobs.delete(id);
      if (jobs.size < MAX_BG_JOBS) return;
    }
  }
  // All running: drop oldest by startedAt to bound memory.
  let oldest: string | null = null;
  let oldestAt = Infinity;
  for (const [id, job] of jobs) {
    if (job.startedAt < oldestAt) {
      oldestAt = job.startedAt;
      oldest = id;
    }
  }
  if (oldest) jobs.delete(oldest);
}

export interface SpawnRunOptions {
  timeoutMs?: number;
  background?: boolean;
  signal?: AbortSignal;
  onChunk?: (chunk: string) => void;
}

export function runSpawn(
  repoRoot: string,
  command: string,
  opts: SpawnRunOptions = {},
): Promise<{ jobId?: string; output: string; exitCode: number }> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const isWin = process.platform === "win32";
  const shell = isWin ? "cmd.exe" : "sh";
  const shellArgs = isWin ? ["/d", "/s", "/c", `"${command}"`] : ["-c", command];
  const spawnOpts = {
    cwd: repoRoot,
    windowsHide: true,
    windowsVerbatimArguments: isWin,
  };

  if (opts.background) {
    const id = `bg_${Date.now().toString(36)}_${counter++}`;
    const job: BgJob = { id, command, output: "", done: false, startedAt: Date.now() };
    const proc = spawn(shell, shellArgs, { ...spawnOpts, detached: !isWin });
    job.proc = proc;
    proc.stdout?.on("data", (d: Buffer) => { job.output = appendCapped(job.output, d.toString()); opts.onChunk?.(d.toString()); });
    proc.stderr?.on("data", (d: Buffer) => { job.output = appendCapped(job.output, d.toString()); opts.onChunk?.(d.toString()); });
    proc.on("close", (code) => { job.done = true; job.exitCode = code ?? 1; });
    proc.on("error", (e) => { job.done = true; job.output = appendCapped(job.output, `\n[spawn error: ${(e as Error).message}]`); });
    if (opts.signal) {
      if (opts.signal.aborted) killTree(proc);
      else opts.signal.addEventListener("abort", () => killTree(proc), { once: true });
    }
    evictOldJobs();
    jobs.set(id, job);
    return Promise.resolve({ jobId: id, output: `Started background job ${id}: ${command}`, exitCode: 0 });
  }

  return new Promise((resolve, reject) => {
    const proc = spawn(shell, shellArgs, { ...spawnOpts, detached: !isWin });
    let output = "";
    let settled = false;
    const cleanup = (): void => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = (): void => {
      killTree(proc);
      if (!settled) {
        settled = true;
        cleanup();
        reject(new Error("Provider request cancelled (AbortSignal)."));
      }
    };
    const timer = setTimeout(() => {
      killTree(proc);
      if (!settled) {
        settled = true;
        opts.signal?.removeEventListener("abort", onAbort);
        reject(new Error(`Command timed out after ${timeoutMs / 1000}s: ${command}`));
      }
    }, timeoutMs);
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }
    proc.stdout?.on("data", (d: Buffer) => { const s = d.toString(); output = appendCapped(output, s); opts.onChunk?.(s); });
    proc.stderr?.on("data", (d: Buffer) => { const s = d.toString(); output = appendCapped(output, s); opts.onChunk?.(s); });
    proc.on("error", (e) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`Command failed: ${(e as Error).message}`));
    });
    proc.on("close", (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ output: `exit code: ${code ?? 1}\n${output}`.trim(), exitCode: code ?? 1 });
    });
  });
}

export function readBgOutput(jobId: string, limitChars = 12_000): string {
  const job = jobs.get(jobId);
  if (!job) throw new Error(`Unknown background job: ${jobId}`);
  const tail = job.output.slice(-limitChars);
  return `[${job.id}] ${job.done ? `done (exit ${job.exitCode ?? "?"})` : "running"}: ${job.command}\n${tail}`;
}

export function killBgJob(jobId: string): string {
  const job = jobs.get(jobId);
  if (!job) throw new Error(`Unknown background job: ${jobId}`);
  if (job.done) return `[${job.id}] already finished (exit ${job.exitCode ?? "?"}).`;
  killTree(job.proc);
  job.done = true;
  return `[${job.id}] killed: ${job.command}`;
}
