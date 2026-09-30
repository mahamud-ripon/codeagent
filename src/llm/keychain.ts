import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * ML-7: keys in OS keychain when available, else ~/.codeagent/.env mode 0600.
 * keytar is optional; when absent we use the 0600 file only (no new dep).
 */

export function globalEnvPath(homeDir: string = os.homedir()): string {
  return path.join(homeDir, ".codeagent", ".env");
}

export function ensure0600(file: string): void {
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // best effort (Windows ACLs differ)
  }
}

export function readEnvFile(file: string): Record<string, string> {
  try {
    const raw = fs.readFileSync(file, "utf8");
    const out: Record<string, string> = {};
    for (const line of raw.split("\n")) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m) out[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
    }
    return out;
  } catch {
    return {};
  }
}

export function writeEnvKey(file: string, key: string, value: string): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const current = readEnvFile(file);
  current[key] = value;
  const body = Object.entries(current).map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
  fs.writeFileSync(file, body, { mode: 0o600 });
  ensure0600(file);
}

/** Try the OS keychain via optional keytar; returns null when unavailable. */
export async function keychainGet(service: string, account: string): Promise<string | null> {
  try {
    // keytar is optional — no @types dependency. Resolve dynamically at runtime only.
    const mod = await new Function("s", "return import(s)")("keytar").catch(() => null) as unknown as { getPassword?: (s: string, a: string) => Promise<string | null> } | null;
    if (!mod?.getPassword) return null;
    return (await mod.getPassword(service, account)) ?? null;
  } catch {
    return null;
  }
}

export async function keychainSet(service: string, account: string, password: string): Promise<boolean> {
  try {
    const mod = await new Function("s", "return import(s)")("keytar").catch(() => null) as unknown as { setPassword?: (s: string, a: string, p: string) => Promise<void> } | null;
    if (!mod?.setPassword) return false;
    await mod.setPassword(service, account, password);
    return true;
  } catch {
    return false;
  }
}

/** Resolution order: env → keychain → ~/.codeagent/.env (0600). Never throws. */
export async function resolveSecret(key: string, opts?: { service?: string; homeDir?: string }): Promise<string | undefined> {
  if (process.env[key]) return process.env[key];
  const fromChain = await keychainGet(opts?.service ?? "codeagent", key);
  if (fromChain) return fromChain;
  const file = globalEnvPath(opts?.homeDir);
  return readEnvFile(file)[key];
}

export function resolveSecretSync(key: string, homeDir: string = os.homedir()): string | undefined {
  if (process.env[key]) return process.env[key];
  return readEnvFile(globalEnvPath(homeDir))[key];
}
