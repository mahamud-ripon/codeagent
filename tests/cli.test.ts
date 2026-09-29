import { describe, expect, it, vi, afterEach } from "vitest";
import { parseArgs } from "../src/index.js";

describe("parseArgs", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns defaults for empty argv", () => {
    const args = parseArgs([]);
    expect(args.task).toBe("");
    expect(args.repo).toBe(process.cwd());
    expect(args.model).toBeUndefined();
    expect(args.provider).toBeUndefined();
    expect(args.baseURL).toBeUndefined();
    expect(args.sandbox).toBeUndefined();
    expect(args.maxIterations).toBe(30);
    expect(args.resume).toBeUndefined();
    expect(args.showSessions).toBeFalsy();
  });

  it("joins positional words into a task", () => {
    const args = parseArgs(["Fix", "the", "failing", "test"]);
    expect(args.task).toBe("Fix the failing test");
  });

  it("parses --repo in space and = forms", () => {
    expect(parseArgs(["--repo", "./my-app"]).repo).toBe("./my-app");
    expect(parseArgs(["--repo=./my-app"]).repo).toBe("./my-app");
  });

  it("parses model (-m / --model) in space and = forms", () => {
    expect(parseArgs(["-m", "gpt-4o"]).model).toBe("gpt-4o");
    expect(parseArgs(["--model", "gpt-4o"]).model).toBe("gpt-4o");
    expect(parseArgs(["--model=gpt-4o"]).model).toBe("gpt-4o");
    expect(parseArgs(["-m=gpt-4o"]).model).toBe("gpt-4o");
  });

  it("parses provider (-p / --provider) in space and = forms", () => {
    expect(parseArgs(["-p", "chat"]).provider).toBe("chat");
    expect(parseArgs(["--provider", "openai"]).provider).toBe("openai");
    expect(parseArgs(["--provider=chat"]).provider).toBe("chat");
    expect(parseArgs(["-p=openai"]).provider).toBe("openai");
  });

  it("parses endpoint (-e / --endpoint) in space and = forms", () => {
    expect(parseArgs(["-e", "http://localhost:11434/v1"]).baseURL).toBe("http://localhost:11434/v1");
    expect(parseArgs(["--endpoint", "https://api.groq.com/openai/v1"]).baseURL).toBe("https://api.groq.com/openai/v1");
    expect(parseArgs(["--endpoint=http://localhost:11434/v1"]).baseURL).toBe("http://localhost:11434/v1");
    expect(parseArgs(["-e=http://localhost:11434/v1"]).baseURL).toBe("http://localhost:11434/v1");
  });

  it("parses iterations (-i / --iterations / --max-iterations) as the same setting", () => {
    expect(parseArgs(["-i", "15"]).maxIterations).toBe(15);
    expect(parseArgs(["--iterations", "15"]).maxIterations).toBe(15);
    expect(parseArgs(["--iterations=15"]).maxIterations).toBe(15);
    expect(parseArgs(["-i=15"]).maxIterations).toBe(15);
    expect(parseArgs(["--max-iterations", "15"]).maxIterations).toBe(15);
    expect(parseArgs(["--max-iterations=15"]).maxIterations).toBe(15);
  });

  it("parses sandbox (-s / --sandbox) in space and = forms", () => {
    expect(parseArgs(["-s", "docker"]).sandbox).toBe("docker");
    expect(parseArgs(["--sandbox", "local"]).sandbox).toBe("local");
    expect(parseArgs(["--sandbox=docker"]).sandbox).toBe("docker");
    expect(parseArgs(["-s=local"]).sandbox).toBe("local");
  });

  it("parses resume with id, bare, and = forms", () => {
    expect(parseArgs(["-r"]).resume).toBe(true);
    expect(parseArgs(["--resume"]).resume).toBe(true);
    expect(parseArgs(["-r", "ses_123"]).resume).toBe("ses_123");
    expect(parseArgs(["--resume", "2"]).resume).toBe("2");
    expect(parseArgs(["--resume=ses_123"]).resume).toBe("ses_123");
  });

  it("parses --sessions", () => {
    expect(parseArgs(["--sessions"]).showSessions).toBe(true);
  });

  it("parses auto-approval flags (-y / --auto / --yes / --auto-approve)", () => {
    expect(parseArgs([]).autoApprove).toBe(false);
    expect(parseArgs(["-y"]).autoApprove).toBe(true);
    expect(parseArgs(["--auto"]).autoApprove).toBe(true);
    expect(parseArgs(["--yes"]).autoApprove).toBe(true);
    expect(parseArgs(["--auto-approve"]).autoApprove).toBe(true);
  });

  it("combines flags with a task", () => {
    const args = parseArgs(["Add", "pagination", "-m", "openai/gpt-oss-20b", "-p", "chat", "-s", "docker"]);
    expect(args.task).toBe("Add pagination");
    expect(args.model).toBe("openai/gpt-oss-20b");
    expect(args.provider).toBe("chat");
    expect(args.sandbox).toBe("docker");
  });

  it("rejects invalid provider values", () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as never);
    expect(() => parseArgs(["-p", "invalid"])).toThrow("exit");
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("rejects invalid sandbox values", () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as never);
    expect(() => parseArgs(["-s", "remote"])).toThrow("exit");
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("rejects non-positive iteration counts", () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as never);
    expect(() => parseArgs(["-i", "0"])).toThrow("exit");
    expect(() => parseArgs(["--max-iterations=abc"])).toThrow("exit");
    expect(exit).toHaveBeenCalledWith(1);
  });
});
