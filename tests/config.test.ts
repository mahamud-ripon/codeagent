import { describe, expect, it, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deleteEnvKey, ensureEndpointForKey, globalEnvPath, loadGlobalEnv, upsertEnvKey } from "../src/cli/config.js";

function tmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agent-home-"));
}

afterEach(() => {
  delete process.env.CA_TEST_UNSET;
  delete process.env.CA_TEST_SET;
});

describe("global config", () => {
  it("resolves to ~/.codeagent/.env", () => {
    expect(globalEnvPath("/fake/home")).toBe(path.join("/fake/home", ".codeagent", ".env"));
  });

  it("upsert creates parent dirs and writes the key", () => {
    const home = tmpHome();
    const file = upsertEnvKey(globalEnvPath(home), "OPENAI_API_KEY", "gsk_abc");
    expect(fs.readFileSync(file, "utf8")).toContain("OPENAI_API_KEY=gsk_abc");
  });

  it("upsert replaces in place and preserves siblings", () => {
    const home = tmpHome();
    const file = globalEnvPath(home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "MODEL=x\nOPENAI_API_KEY=old\n");
    upsertEnvKey(file, "OPENAI_API_KEY", "new");
    const content = fs.readFileSync(file, "utf8");
    expect(content).toContain("OPENAI_API_KEY=new");
    expect(content).toContain("MODEL=x");
    expect(content).not.toContain("=old");
  });

  it("loads global keys only for unset vars (explicit env wins)", () => {
    const home = tmpHome();
    const file = globalEnvPath(home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "CA_TEST_UNSET=from-global\nCA_TEST_SET=from-global\n");
    process.env.CA_TEST_SET = "explicit";
    const applied = loadGlobalEnv(home);
    expect(process.env.CA_TEST_UNSET).toBe("from-global");
    expect(process.env.CA_TEST_SET).toBe("explicit");
    expect(applied).toEqual({ CA_TEST_UNSET: "from-global" });
  });

  it("returns {} when no global file exists", () => {
    expect(loadGlobalEnv(tmpHome())).toEqual({});
  });

  it("deleteEnvKey removes only the named line", () => {
    const home = tmpHome();
    const file = globalEnvPath(home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "A=1\nOPENAI_BASE_URL=https://x\nB=2\n");
    deleteEnvKey(file, "OPENAI_BASE_URL");
    const content = fs.readFileSync(file, "utf8");
    expect(content).toContain("A=1");
    expect(content).toContain("B=2");
    expect(content).not.toContain("OPENAI_BASE_URL");
  });
});

describe("ensureEndpointForKey", () => {
  function fakeEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    return { ...extra } as NodeJS.ProcessEnv;
  }

  it("derives Groq endpoint + default model from a gsk_ key", () => {
    const env = fakeEnv({ OPENAI_API_KEY: "gsk_test" });
    const persisted: Array<[string, string]> = [];
    const notices = ensureEndpointForKey({}, { env, persist: (n, v) => void persisted.push([n, v]) });
    expect(env.OPENAI_BASE_URL).toBe("https://api.groq.com/openai/v1");
    expect(env.MODEL).toBe("openai/gpt-oss-20b");
    expect(persisted).toContainEqual(["OPENAI_BASE_URL", "https://api.groq.com/openai/v1"]);
    expect(persisted).toContainEqual(["MODEL", "openai/gpt-oss-20b"]);
    expect(notices).toHaveLength(2);
  });

  it("leaves configured endpoints and explicit choices alone", () => {
    const env = fakeEnv({ OPENAI_API_KEY: "gsk_test", OPENAI_BASE_URL: "https://custom" });
    expect(ensureEndpointForKey({}, { env, persist: () => {} })).toEqual([]);
    expect(env.OPENAI_BASE_URL).toBe("https://custom");

    const env2 = fakeEnv({ OPENAI_API_KEY: "gsk_test", LLM_PROVIDER: "openai" });
    expect(ensureEndpointForKey({}, { env: env2, persist: () => {} })).toEqual([]);
    expect(env2.OPENAI_BASE_URL).toBeUndefined();

    const env3 = fakeEnv({ OPENAI_API_KEY: "gsk_test", MODEL: "my-model" });
    const persisted: string[] = [];
    ensureEndpointForKey({}, { env: env3, persist: (n) => void persisted.push(n) });
    expect(env3.MODEL).toBe("my-model");
    expect(persisted).not.toContain("MODEL");
  });

  it("does nothing without a key or with an unknown prefix", () => {
    expect(ensureEndpointForKey({}, { env: fakeEnv(), persist: () => {} })).toEqual([]);
    const env = fakeEnv({ OPENAI_API_KEY: "sk-proj-xyz" });
    expect(ensureEndpointForKey({}, { env, persist: () => {} })).toEqual([]);
    expect(env.OPENAI_BASE_URL).toBeUndefined();
  });
});
