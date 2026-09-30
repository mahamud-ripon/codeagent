import { describe, expect, it, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ensure0600,
  globalEnvPath,
  keychainGet,
  keychainSet,
  readEnvFile,
  resolveSecret,
  resolveSecretSync,
  writeEnvKey,
} from "../src/llm/keychain.js";

/** ML-7 offline verification: the 0600-file path round-trips; the OS-keychain path degrades safely. */

const KEY = "CODEAGENT_TEST_ONLY_SECRET_XYZ";
let tmpHomes: string[] = [];

function tmpHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codeagent-home-"));
  tmpHomes.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of tmpHomes.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  delete process.env[KEY];
});

describe("0600 file secrets", () => {
  it("write + read round-trips and preserves sibling keys", () => {
    const home = tmpHome();
    const file = globalEnvPath(home);
    writeEnvKey(file, "A", "1");
    writeEnvKey(file, KEY, "s3cr3t");
    expect(readEnvFile(file)).toMatchObject({ A: "1", [KEY]: "s3cr3t" });
    expect(fs.existsSync(file)).toBe(true);
  });

  it("strips surrounding quotes and ignores blank lines", () => {
    const home = tmpHome();
    const file = globalEnvPath(home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `\n${KEY}="quoted value"\nOTHER='x'\n`);
    expect(readEnvFile(file)[KEY]).toBe("quoted value");
  });

  it("missing file reads as empty and chmod is best-effort", () => {
    const home = tmpHome();
    expect(readEnvFile(globalEnvPath(home))).toEqual({});
    expect(() => ensure0600(path.join(home, "nope"))).not.toThrow();
  });

  it("file is created 0600 on POSIX", () => {
    if (process.platform === "win32") return;
    const home = tmpHome();
    const file = globalEnvPath(home);
    writeEnvKey(file, KEY, "v");
    const mode = fs.statSync(file).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("resolveSecretSync reads the home-scoped file, never the real HOME", () => {
    const home = tmpHome();
    writeEnvKey(globalEnvPath(home), KEY, "scoped");
    expect(resolveSecretSync(KEY, home)).toBe("scoped");
    // The real HOME must not have been touched by the scoped write.
    expect(describeRealHomeUntouched()).toBe(true);
  });

  it("process env wins over the file", async () => {
    const home = tmpHome();
    writeEnvKey(globalEnvPath(home), KEY, "file-value");
    process.env[KEY] = "env-value";
    expect(resolveSecretSync(KEY, home)).toBe("env-value");
    expect(await resolveSecret(KEY, { homeDir: home })).toBe("env-value");
  });

  it("async resolve falls back to the file when env is absent", async () => {
    const home = tmpHome();
    writeEnvKey(globalEnvPath(home), KEY, "file-value");
    expect(await resolveSecret(KEY, { homeDir: home })).toBe("file-value");
    expect(await resolveSecret("CODEAGENT_TEST_ONLY_MISSING_XYZ", { homeDir: home })).toBeUndefined();
  });
});

function describeRealHomeUntouched(): boolean {
  // resolveSecretSync(KEY) without a homeDir reads process.env then the real
  // ~/.codeagent/.env — both must be empty for this test-only key.
  return resolveSecretSync(KEY) === undefined;
}

describe("OS keychain degradation", () => {
  it("returns null/false when keytar is unavailable", async () => {
    expect(await keychainGet("codeagent", KEY)).toBeNull();
    expect(await keychainSet("codeagent", KEY, "v")).toBe(false);
  });
});
