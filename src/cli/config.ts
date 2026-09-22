import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import dotenv from "dotenv";

/**
 * Configure-once storage: ~/.codeagent/.env
 *
 * Resolution order (first win):
 *   1. real environment variables (explicit export always wins)
 *   2. <cwd>/.env (per-project override, loaded by dotenv/config)
 *   3. ~/.codeagent/.env (global fallback, loaded here)
 *
 * So /key configures once globally; a project .env can still override.
 */

export function globalDir(home: string = os.homedir()): string {
  return path.join(home, ".codeagent");
}

export function globalEnvPath(home: string = os.homedir()): string {
  return path.join(globalDir(home), ".env");
}

/**
 * Load the global env file for keys not already set.
 * Never overrides explicit env or the project-local .env.
 * Returns the keys that were applied (useful for logging/tests).
 */
export function loadGlobalEnv(home: string = os.homedir()): Record<string, string> {
  let raw: string;
  try {
    raw = fs.readFileSync(globalEnvPath(home), "utf8");
  } catch {
    return {};
  }
  let parsed: Record<string, string>;
  try {
    parsed = dotenv.parse(raw);
  } catch {
    return {};
  }
  const applied: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (process.env[k] === undefined) {
      process.env[k] = v;
      applied[k] = v;
    }
  }
  return applied;
}

/**
 * Set or replace NAME=value in an env file, creating parent dirs.
 * Preserves comments, ordering, and all other lines.
 */
export function upsertEnvKey(file: string, name: string, value: string): string {
  if (!value || /\s/.test(value)) {
    throw new Error("Value must be a single non-empty token.");
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let lines: string[] = [];
  try {
    if (fs.existsSync(file)) {
      lines = fs.readFileSync(file, "utf8").split("\n");
    }
  } catch {
    lines = [];
  }
  const pattern = new RegExp(`^\\s*${name}\\s*=`);
  let replaced = false;
  lines = lines.map((l) => {
    if (pattern.test(l)) {
      replaced = true;
      return `${name}=${value}`;
    }
    return l;
  });
  if (!replaced) {
    if (lines.length > 0 && lines[lines.length - 1] !== "") lines.push("");
    lines.push(`${name}=${value}`);
  }
  fs.writeFileSync(file, lines.join("\n").replace(/\n+$/, "\n"));
  return file;
}

/** Remove a NAME= line from an env file (no-op if absent). */
export function deleteEnvKey(file: string, name: string): void {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return;
  }
  const pattern = new RegExp(`^\\s*${name}\\s*=.*(?:\\r?\\n|$)`, "gm");
  const cleaned = raw.replace(pattern, "").replace(/\n+$/, "\n");
  fs.writeFileSync(file, cleaned);
}

/** Well-known key prefixes mapped to their OpenAI-compatible endpoint. */
const KEY_PREFIX_ENDPOINTS: Array<{
  prefix: string;
  baseURL: string;
  label: string;
  defaultModel?: string;
}> = [
  {
    prefix: "gsk_",
    baseURL: "https://api.groq.com/openai/v1",
    label: "Groq",
    defaultModel: "openai/gpt-oss-20b",
  },
  {
    prefix: "AIza",
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
    label: "Gemini",
    defaultModel: "gemini-2.0-flash",
  },
  {
    prefix: "sk-or-",
    baseURL: "https://openrouter.ai/api/v1",
    label: "OpenRouter",
  },
];

export function detectEndpointForKey(key: string): {
  baseURL: string;
  label: string;
  defaultModel?: string;
} | null {
  for (const entry of KEY_PREFIX_ENDPOINTS) {
    if (key.startsWith(entry.prefix)) return entry;
  }
  return null;
}

export interface EndpointHealOptions {
  provider?: string;
  baseURL?: string;
  model?: string;
  /** Persist derived values globally (default true; /key --local passes false). */
  persistGlobals?: boolean;
}

export interface EndpointHealDeps {
  env?: NodeJS.ProcessEnv;
  home?: string;
  persist?: (name: string, value: string) => void;
}

/**
 * Self-heal for keys configured before auto-detect existed (or pasted
 * straight into .env): if the saved key belongs to a known vendor and
 * no endpoint is configured, derive it — plus a default model when the
 * user never chose one. Explicit user choices (endpoint, provider=openai,
 * model) are never overridden. Returns human-readable notices.
 */
export function ensureEndpointForKey(
  opts: EndpointHealOptions = {},
  deps: EndpointHealDeps = {},
): string[] {
  const env = deps.env ?? process.env;
  const persist =
    deps.persist ??
    ((name: string, value: string) => {
      try {
        upsertEnvKey(globalEnvPath(deps.home), name, value);
      } catch {
        // persistence is best-effort; in-memory env still applies
      }
    });
  const notices: string[] = [];

  const key = env.OPENAI_API_KEY;
  if (!key) return notices;
  const detected = detectEndpointForKey(key);
  if (!detected) return notices;

  const endpoint = opts.baseURL ?? env.OPENAI_BASE_URL;
  const explicitOpenai =
    (opts.provider ?? env.LLM_PROVIDER ?? "").trim().toLowerCase() === "openai";
  if (endpoint || explicitOpenai) return notices;

  env.OPENAI_BASE_URL = detected.baseURL;
  if (opts.persistGlobals ?? true) persist("OPENAI_BASE_URL", detected.baseURL);
  notices.push(
    `Detected a ${detected.label} key — endpoint set to ${detected.baseURL} (persisted globally).`,
  );

  const model = opts.model ?? env.MODEL;
  if (!model && detected.defaultModel) {
    env.MODEL = detected.defaultModel;
    if (opts.persistGlobals ?? true) persist("MODEL", detected.defaultModel);
    notices.push(
      `No model configured — defaulted to ${detected.defaultModel} (change anytime with /model).`,
    );
  }
  return notices;
}
