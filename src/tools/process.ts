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
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(proc.pid), "/t", "/f"]);
    } else {
      try { process.kill(-(proc.pid ?? 0), "SIGKILL"); } catch { proc.kill("SIGKILL"); }
    }
  } catch {
    try { proc.kill("SIGKILL"); } catch { /* best effort */ }
  }
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
  const shell = process.platform === "win32" ? "cmd.exe" : "sh";
  const shellArgs = process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-c", command];

  if (opts.background) {
    const id = `bg_${Date.now().toString(36)}_${counter++}`;
    const job: BgJob = { id, command, output: "", done: false, startedAt: Date.now() };
    const proc = spawn(shell, shellArgs, { cwd: repoRoot, windowsHide: true, detached: process.platform !== "win32" });
    job.proc = proc;
    proc.stdout?.on("data", (d: Buffer) => { job.output += d.toString(); opts.onChunk?.(d.toString()); });
    proc.stderr?.on("data", (d: Buffer) => { job.output += d.toString(); opts.onChunk?.(d.toString()); });
    proc.on("close", (code) => { job.done = true; job.exitCode = code ?? 1; });
    proc.on("error", (e) => { job.done = true; job.output += `\n[spawn error: ${(e as Error).message}]`; });
    if (opts.signal) opts.signal.addEventListener("abort", () => killTree(proc), { once: true });
    jobs.set(id, job);
    return Promise.resolve({ jobId: id, output: `Started background job ${id}: ${command}`, exitCode: 0 });
  }

  return new Promise((resolve, reject) => {
    const proc = spawn(shell, shellArgs, { cwd: repoRoot, windowsHide: true });
    let output = "";
    const timer = setTimeout(() => {
      killTree(proc);
      reject(new Error(`Command timed out after ${timeoutMs / 1000}s: ${command}`));
    }, timeoutMs);
    if (opts.signal) opts.signal.addEventListener("abort", () => { killTree(proc); }, { once: true });
    proc.stdout?.on("data", (d: Buffer) => { const s = d.toString(); output += s; opts.onChunk?.(s); });
    proc.stderr?.on("data", (d: Buffer) => { const s = d.toString(); output += s; opts.onChunk?.(s); });
    proc.on("error", (e) => { clearTimeout(timer); reject(new Error(`Command failed: ${(e as Error).message}`)); });
    proc.on("close", (code) => {
      clearTimeout(timer);
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
