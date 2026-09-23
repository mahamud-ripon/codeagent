import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import {
  type CommandResult,
  type CommandRunner,
  DevLocalCommandRunner,
  COMMAND_TIMEOUT_MS,
} from "./runner.js";
import { TRUNCATION_BUDGETS, truncate } from "../utils/truncate.js";

const execFileAsync = promisify(execFile);

export interface DockerSandboxOptions {
  image?: string;
  memoryLimit?: string;
  cpuLimit?: string;
  fallbackRunner?: CommandRunner;
}

/**
 * Executes shell commands inside an isolated Docker container with volume-mounted workspace.
 * Gracefully falls back to DevLocalCommandRunner if Docker is unavailable.
 */
export class DockerCommandRunner implements CommandRunner {
  private image: string;
  private memoryLimit: string;
  private cpuLimit: string;
  private fallback: CommandRunner;
  private cachedAvailability: boolean | null = null;
  private lastCheckTime = 0;

  constructor(options?: DockerSandboxOptions) {
    this.image = options?.image ?? process.env.SANDBOX_IMAGE ?? "node:20-slim";
    this.memoryLimit = options?.memoryLimit ?? "2g";
    this.cpuLimit = options?.cpuLimit ?? "2";
    this.fallback = options?.fallbackRunner ?? new DevLocalCommandRunner();
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
      await execFileAsync("docker", ["version", "--format", "{{.Server.Version}}"], {
        timeout: 3_000,
      });
      this.cachedAvailability = true;
    } catch {
      this.cachedAvailability = false;
    }
    this.lastCheckTime = now;
    return this.cachedAvailability;
  }

  async run(repoRoot: string, command: string, signal?: AbortSignal): Promise<CommandResult> {
    const available = await this.isDockerAvailable();
    if (!available) {
      return this.fallback.run(repoRoot, command, signal);
    }

    // Prepare workspace mount path
    const resolved = path.resolve(repoRoot);
    // On Windows, Docker CLI supports forward-slashed absolute paths (e.g. C:/Users/...:/workspace)
    const mountPath = resolved.replace(/\\/g, "/");

    const dockerArgs = [
      "run",
      "--rm",
      "-i",
      "-v",
      `${mountPath}:/workspace`,
      "-w",
      "/workspace",
      `--memory=${this.memoryLimit}`,
      `--cpus=${this.cpuLimit}`,
      this.image,
      "sh",
      "-c",
      command,
    ];

    try {
      const { stdout, stderr } = await execFileAsync("docker", dockerArgs, {
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer: 2 * 1024 * 1024,
        signal,
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
        throw new Error(`Sandboxed command timed out after ${COMMAND_TIMEOUT_MS / 1000}s: ${command}`);
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
      // If docker run completely failed (e.g. daemon stopped mid-session), fall back
      return this.fallback.run(repoRoot, command, signal);
    }
  }
}

let activeRunner: CommandRunner = new DevLocalCommandRunner();
let currentSandboxMode: "local" | "docker" = "local";

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
    activeRunner = new DevLocalCommandRunner();
    currentSandboxMode = "local";
    return {
      success: false,
      mode: "local",
      message: "Docker daemon is not running or available. Remaining on local runner.",
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
