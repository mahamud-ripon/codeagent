import { describe, expect, it } from "vitest";
import {
  DockerCommandRunner,
  getActiveCommandRunner,
  getSandboxMode,
  setActiveCommandRunner,
  setSandboxMode,
} from "../src/tools/sandbox.js";
import {
  DevLocalCommandRunner,
  type CommandRunner,
} from "../src/tools/terminal.js";

describe("DockerCommandRunner", () => {
  it("checks Docker availability without throwing", async () => {
    const runner = new DockerCommandRunner();
    const available = await runner.isDockerAvailable();
    expect(typeof available).toBe("boolean");
  });

  it("fails closed when Docker is not available", async () => {
    const fakeFallback: CommandRunner = {
      run: async () => ({
        exitCode: 0,
        stdout: "fallback executed",
        stderr: "",
        combined: "fallback executed",
      }),
    };

    const runner = new DockerCommandRunner({ fallbackRunner: fakeFallback });
    // Force isDockerAvailable to return false for test
    runner.isDockerAvailable = async () => false;

    await expect(runner.run(".", "echo hello")).rejects.toThrow(
      "Docker sandbox unavailable",
    );
  });

  it("manages global sandbox mode and runner switching", async () => {
    await setSandboxMode("local");
    expect(getSandboxMode()).toBe("local");
    expect(getActiveCommandRunner() instanceof DevLocalCommandRunner).toBe(
      true,
    );

    const customRunner: CommandRunner = {
      run: async () => ({ exitCode: 0, stdout: "", stderr: "", combined: "" }),
    };
    setActiveCommandRunner(customRunner);
    expect(getActiveCommandRunner()).toBe(customRunner);

    // Reset back to local
    await setSandboxMode("local");
    expect(getSandboxMode()).toBe("local");
  });
});
