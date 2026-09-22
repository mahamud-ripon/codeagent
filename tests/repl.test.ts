import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  detectEndpointForKey,
  isSensitiveLine,
  parseSlashCommand,
  saveApiKeyToEnvFile,
} from "../src/cli/repl.js";
import { createProviderFromEnv, describeProviderFromEnv } from "../src/llm/provider.js";

describe("parseSlashCommand", () => {
  it("returns null for plain tasks", () => {
    expect(parseSlashCommand("Fix the failing test")).toBeNull();
    expect(parseSlashCommand("")).toBeNull();
  });

  it("parses bare commands", () => {
    expect(parseSlashCommand("/help")).toEqual({ cmd: "help", args: "" });
    expect(parseSlashCommand("/EXIT")).toEqual({ cmd: "exit", args: "" });
  });

  it("splits command and args", () => {
    expect(parseSlashCommand("/model openai/gpt-oss-20b")).toEqual({
      cmd: "model",
      args: "openai/gpt-oss-20b",
    });
    expect(parseSlashCommand("/repo  ./my-app ")).toEqual({ cmd: "repo", args: "./my-app" });
  });
});

describe("detectEndpointForKey", () => {
  it("maps known key prefixes to endpoints", () => {
    expect(detectEndpointForKey("gsk_abc")).toMatchObject({ label: "Groq" });
    expect(detectEndpointForKey("AIzaXYZ")).toMatchObject({ label: "Gemini" });
    expect(detectEndpointForKey("sk-or-123")).toMatchObject({ label: "OpenRouter" });
  });

  it("returns null for unknown keys (e.g. OpenAI)", () => {
    expect(detectEndpointForKey("sk-proj-xyz")).toBeNull();
  });
});

describe("provider overrides (REPL session switching)", () => {
  it("model override wins over env", () => {
    const { info } = createProviderFromEnv(
      { OPENAI_API_KEY: "k", MODEL: "env-model" } as NodeJS.ProcessEnv,
      { model: "session-model" },
    );
    expect(info.model).toBe("session-model");
  });

  it("baseURL override implies chat", () => {
    const { info } = createProviderFromEnv({ OPENAI_API_KEY: "k" } as NodeJS.ProcessEnv, {
      baseURL: "http://localhost:11434/v1",
      model: "qwen2.5-coder:7b",
    });
    expect(info).toMatchObject({ kind: "openai-chat", baseURL: "http://localhost:11434/v1" });
  });

  it("provider override forces chat without a baseURL", () => {
    const { info } = createProviderFromEnv({ OPENAI_API_KEY: "k" } as NodeJS.ProcessEnv, {
      provider: "chat",
      model: "x",
    });
    expect(info.kind).toBe("openai-chat");
  });
});

describe("describeProviderFromEnv (no key required)", () => {
  it("reports needsKey without throwing", () => {
    const info = describeProviderFromEnv({} as NodeJS.ProcessEnv);
    expect(info).toMatchObject({ kind: "openai-responses", needsKey: true });
  });

  it("local endpoint needs no key", () => {
    const info = describeProviderFromEnv({
      OPENAI_BASE_URL: "http://localhost:11434/v1",
    } as NodeJS.ProcessEnv);
    expect(info).toMatchObject({ kind: "openai-chat", needsKey: false });
  });
});

describe("API key handling", () => {
  it("flags /key lines as sensitive", () => {
    expect(isSensitiveLine("/key gsk_secret")).toBe(true);
    expect(isSensitiveLine("/KEY gsk_secret")).toBe(true);
    expect(isSensitiveLine("/model x")).toBe(false);
    expect(isSensitiveLine("fix the bug")).toBe(false);
  });

  it("throws a friendly error (not a stack) when the key is missing", () => {
    expect(() => createProviderFromEnv({} as NodeJS.ProcessEnv)).toThrow(/\/key/);
  });
});

describe("saveApiKeyToEnvFile", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "agent-key-"));
  });
  afterEach(async () => {
    delete process.env.OPENAI_API_KEY;
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("creates .env with the key", async () => {
    const file = saveApiKeyToEnvFile(tmp, "gsk_test123");
    expect(await fs.readFile(file, "utf8")).toContain("OPENAI_API_KEY=gsk_test123");
    expect(process.env.OPENAI_API_KEY).toBe("gsk_test123");
  });

  it("replaces an existing key line, preserving the rest", async () => {
    await fs.writeFile(path.join(tmp, ".env"), "MODEL=x\nOPENAI_API_KEY=old\nFOO=1\n");
    const file = saveApiKeyToEnvFile(tmp, "new");
    const content = await fs.readFile(file, "utf8");
    expect(content).toContain("OPENAI_API_KEY=new");
    expect(content).not.toContain("old");
    expect(content).toContain("MODEL=x");
    expect(content).toContain("FOO=1");
  });

  it("rejects keys with whitespace", () => {
    expect(() => saveApiKeyToEnvFile(tmp, "not a key")).toThrow();
  });
});
