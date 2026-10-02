import { randomUUID } from "node:crypto";
import { runSpawn, type SpawnRunOptions } from "./process.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import {
  type CommandResult,
  type CommandRunner,
  DevLocalCommandRunner,
} from "./runner.js";

const execFileAsync = promisify(execFile);

export interface DockerSandboxOptions {
  image?: string;
  memoryLimit?: string;
  cpuLimit?: string;
  network?: boolean;
  mounts?: string[];
  fallbackRunner?: CommandRunner;
}

/**
 * Executes shell commands inside an isolated Docker container with volume-mounted workspace.
 * Requested isolation fails closed when Docker cannot execute it.
 */
export class DockerCommandRunner implements CommandRunner {
  private image: string;
  private memoryLimit: string;
  private cpuLimit: string;
  private network: boolean;
  private mounts: string[];
  private cachedAvailability: boolean | null = null;
  private lastCheckTime = 0;

  constructor(options?: DockerSandboxOptions) {
    this.image = options?.image ?? process.env.SANDBOX_IMAGE ?? "node:20-slim";
    this.memoryLimit = options?.memoryLimit ?? "2g";
    this.cpuLimit = options?.cpuLimit ?? "2";
    this.network = options?.network ?? false;
    this.mounts = options?.mounts ?? [];
  }

  /**
   * Fast check to see if Docker daemon is active and responsive.
   */
  async isDockerAvailable(): Promise<boolean> {
    const now = Date.now();
    if (this.cachedAvailability !== null && now - this.lastCheckTime < 15_000) {
      return this.cachedAvailability;
    }

    try {
      await execFileAsync(
        "docker",
        ["version", "--format", "{{.Server.Version}}"],
        {
          timeout: 3_000,
        },
      );
      this.cachedAvailability = true;
    } catch {
      this.cachedAvailability = false;
    }
    this.lastCheckTime = now;
    return this.cachedAvailability;
  }

  async managed(repoRoot: string, command: string, opts: SpawnRunOptions = {}) {
    if (!(await this.isDockerAvailable()))
      throw new Error(
        "Docker sandbox unavailable. Start Docker or explicitly select local execution.",
      );
    const name = `codeagent-${randomUUID()}`;
    const args = [
      "run",
      "--rm",
      "--name",
      name,
      "-i",
      ...(this.network ? [] : ["--network=none"]),
      ...this.mounts.flatMap((mount) => ["-v", mount]),
      "--cap-drop=ALL",
      "--pids-limit=256",
      "--user",
      typeof process.getuid === "function"
        ? `${process.getuid()}:${process.getgid!()}`
        : "node",
      "-v",
      `${path.resolve(repoRoot).replace(/\\/g, "/")}:/workspace`,
      "-w",
      "/workspace",
      `--memory=${this.memoryLimit}`,
      `--cpus=${this.cpuLimit}`,
      this.image,
      "sh",
      "-c",
      command,
    ];
    const cleanup = () => {
      void execFileAsync("docker", ["rm", "-f", name], {
        timeout: 15000,
      }).catch(() => {});
    };
    opts.signal?.addEventListener("abort", cleanup, { once: true });
    try {
      return await runSpawn(repoRoot, command, {
        ...opts,
        executable: { file: "docker", args },
        onExit: () => {
          opts.signal?.removeEventListener("abort", cleanup);
          cleanup();
          opts.onExit?.();
        },
      });
    } catch (error) {
      cleanup();
      throw error;
    }
  }
  async run(
    repoRoot: string,
    command: string,
    signal?: AbortSignal,
  ): Promise<CommandResult> {
    const result = await this.managed(repoRoot, command, { signal });
    const output = result.output.replace(/^exit code:.*\n?/, "");
    return {
      exitCode: result.exitCode,
      stdout: output,
      stderr: "",
      combined: output,
    };
  }
}

let activeRunner: CommandRunner = new DevLocalCommandRunner();
let currentSandboxMode: "local" | "docker" = "local";

/**
 * Per-session runner registry (Claude Code parity: concurrent runs never
 * flip each other's mode mid-tool). Global activeRunner remains the
 * fallback for legacy callers; per-agent context.runner wins when present.
 */
const sessionRunners = new Map<
  string,
  { runner: CommandRunner; mode: "local" | "docker" }
>();

export function setSessionRunner(
  sessionId: string,
  runner: CommandRunner,
  mode: "local" | "docker",
): void {
  sessionRunners.set(sessionId, { runner, mode });
}

export function getSessionRunner(
  sessionId: string,
): { runner: CommandRunner; mode: "local" | "docker" } | undefined {
  return sessionRunners.get(sessionId);
}

export function clearSessionRunner(sessionId: string): void {
  sessionRunners.delete(sessionId);
  void removePersistentContainer(sessionId);
}

export interface SandboxConfig {
  mode?: "local" | "docker";
  image?: string;
  network?: boolean;
  mounts?: string[];
}

/** SF-7: persistent per-session container (docker create/start/exec). */
const persistentContainers = new Map<string, string>();

export function sandboxConfigFromSettings(settings: {
  sandbox?: SandboxConfig;
}): SandboxConfig {
  return {
    mode: settings.sandbox?.mode ?? "local",
    image:
      settings.sandbox?.image ?? process.env.SANDBOX_IMAGE ?? "node:20-slim",
    network: settings.sandbox?.network ?? true,
    mounts: settings.sandbox?.mounts ?? [],
  };
}

export async function ensurePersistentContainer(
  sessionId: string,
  config: SandboxConfig,
): Promise<string | null> {
  if (config.mode !== "docker") return null;
  const existing = persistentContainers.get(sessionId);
  if (existing) return existing;
  try {
    const image = config.image ?? "node:20-slim";
    const name = `codeagent-${sessionId.replace(/[^a-z0-9_-]/gi, "").slice(0, 32)}`;
    const args = [
      "create",
      "--name",
      name,
      "-i",
      "-w",
      "/workspace",
      "--memory=2g",
      "--cpus=2",
      "--pids-limit=256",
      "--cap-drop=ALL",
    ];
    if (config.network === false) args.push("--network=none");
    args.push(image, "sleep", "infinity");
    await execFileAsync("docker", args, { timeout: 30_000 });
    await execFileAsync("docker", ["start", name], { timeout: 15_000 });
    persistentContainers.set(sessionId, name);
    return name;
  } catch {
    return null;
  }
}

export async function removePersistentContainer(
  sessionId: string,
): Promise<void> {
  const name = persistentContainers.get(sessionId);
  if (!name) return;
  persistentContainers.delete(sessionId);
  try {
    await execFileAsync("docker", ["rm", "-f", name], { timeout: 15_000 });
  } catch {
    // best effort
  }
}

export function getActiveCommandRunner(): CommandRunner {
  return activeRunner;
}

export function setActiveCommandRunner(runner: CommandRunner): void {
  activeRunner = runner;
}

export function getSandboxMode(): "local" | "docker" {
  return currentSandboxMode;
}

export async function setSandboxMode(
  mode: "local" | "docker",
): Promise<{ success: boolean; mode: "local" | "docker"; message: string }> {
  if (mode === "docker") {
    const dockerRunner = new DockerCommandRunner();
    const available = await dockerRunner.isDockerAvailable();
    if (available) {
      activeRunner = dockerRunner;
      currentSandboxMode = "docker";
      return {
        success: true,
        mode: "docker",
        message: "Switched to Docker sandbox runner (node:20-slim).",
      };
    }
    // Docker unavailable
    activeRunner = dockerRunner;
    currentSandboxMode = "docker";
    return {
      success: false,
      mode: "docker",
      message:
        "Docker is unavailable. Commands remain blocked until Docker starts or local mode is explicitly selected.",
    };
  }

  activeRunner = new DevLocalCommandRunner();
  currentSandboxMode = "local";
  return {
    success: true,
    mode: "local",
    message: "Switched to local host command runner.",
  };
}
