import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PermissionMode } from "./permissions.js";

export interface PermissionSettings {
  mode?: PermissionMode;
  allow: string[];
  deny: string[];
  ask: string[];
}

/**
 * Model roles (ML-5) and capability overrides (ML-3).
 * Matches the Appendix C shape: `"model": { "main": "...", "fast": "..." }`.
 * A plain string is shorthand for `{ "main": "<id>" }`.
 */
export interface ModelSettings {
  /** Primary agent model. Falls back to $MODEL / provider default. */
  main?: string;
  /** Cheap model for titles, compaction summaries, intent checks. */
  fast?: string;
  /** Model used for plan-mode exploration. Falls back to main. */
  plan?: string;
  /** Small-model mode (ML-4): short prompt, fewer tools, one tool per turn. */
  smallModel?: boolean;
  capabilities?: {
    contextWindow?: number;
    maxOutput?: number;
  };
}

const settingsWarnings = new Set<string>();
export function consumeSettingsWarnings(): string[] {
  const warnings = [...settingsWarnings];
  settingsWarnings.clear();
  return warnings;
}
function readJson(file: string): Record<string, unknown> | null {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new Error(`Invalid settings object: ${file}`);
    const record = raw as Record<string, unknown>;
    if (record.schemaVersion !== undefined && record.schemaVersion !== 1)
      throw new Error(
        `Unsupported settings schemaVersion in ${file}; expected 1`,
      );
    if (record.schemaVersion === undefined)
      settingsWarnings.add(
        `Legacy settings loaded in memory as schemaVersion 1: ${file}. Add schemaVersion: 1 when updating settings.`,
      );
    return record;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is string =>
      typeof item === "string" && item.trim().length > 0,
  );
}

const MODES = new Set<PermissionMode>([
  "default",
  "acceptEdits",
  "plan",
  "bypass",
]);

/**
 * Merge permission rules from the user config, the project config, and the local override.
 * Later files replace `mode`. Allow, ask, and deny lists accumulate. Deny still wins at check time.
 */
export function loadPermissionSettings(
  repoRoot: string,
  homeDir: string = os.homedir(),
): PermissionSettings {
  const files = [
    path.join(homeDir, ".codeagent", "settings.json"),
    path.join(repoRoot, ".codeagent", "settings.json"),
    path.join(repoRoot, ".codeagent", "settings.local.json"),
  ];
  const merged: PermissionSettings = { allow: [], deny: [], ask: [] };
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    const json = readJson(file);
    const permissions = json?.permissions;
    if (!permissions || typeof permissions !== "object") continue;
    const record = permissions as Record<string, unknown>;
    if (
      typeof record.mode === "string" &&
      MODES.has(record.mode as PermissionMode)
    ) {
      merged.mode = record.mode as PermissionMode;
    }
    merged.allow.push(...strings(record.allow));
    merged.deny.push(...strings(record.deny));
    merged.ask.push(...strings(record.ask));
  }
  return merged;
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

/**
 * EX-3 wiring: load user hooks (SessionStart/UserPromptSubmit/PreToolUse/
 * PostToolUse/Stop/PreCompact) from the same three settings files.
 * Later files append; matchers run in file order. Never throws.
 */
export function loadHooksSettings(
  repoRoot: string,
  homeDir: string = os.homedir(),
): import("./hooks.js").HookConfig {
  const files = [
    path.join(homeDir, ".codeagent", "settings.json"),
    path.join(repoRoot, ".codeagent", "settings.json"),
    path.join(repoRoot, ".codeagent", "settings.local.json"),
  ];
  const merged: import("./hooks.js").HookConfig = {};
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    const json = readJson(file);
    const hooks = (json?.hooks ?? {}) as Record<string, unknown>;
    if (!hooks || typeof hooks !== "object") continue;
    for (const [name, defs] of Object.entries(hooks)) {
      if (!Array.isArray(defs)) continue;
      const list = defs
        .filter(
          (d): d is Record<string, unknown> => !!d && typeof d === "object",
        )
        .map((d) => ({
          enforcement: d.enforcement === true,
          timeoutMs: typeof d.timeoutMs === "number" ? d.timeoutMs : undefined,
          matcher: typeof d.matcher === "string" ? d.matcher : undefined,
          command: String((d as { command?: unknown }).command ?? ""),
        }))
        .filter((d) => d.command.trim().length > 0);
      if (list.length === 0) continue;
      const key = name as keyof import("./hooks.js").HookConfig;
      merged[key] = [...(merged[key] ?? []), ...list];
    }
  }
  return merged;
}

/**
 * SF-7 wiring: sandbox config (mode/image/network/mounts) from settings.
 * Last-file-wins per key; env SANDBOX_IMAGE is the image fallback.
 */
export function loadSandboxSettings(
  repoRoot: string,
  homeDir: string = os.homedir(),
): {
  mode?: "local" | "docker";
  image?: string;
  network?: boolean;
  mounts?: string[];
} {
  const files = [
    path.join(homeDir, ".codeagent", "settings.json"),
    path.join(repoRoot, ".codeagent", "settings.json"),
    path.join(repoRoot, ".codeagent", "settings.local.json"),
  ];
  const merged: {
    mode?: "local" | "docker";
    image?: string;
    network?: boolean;
    mounts?: string[];
  } = {};
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    const json = readJson(file);
    const sb = json?.sandbox as Record<string, unknown> | undefined;
    if (!sb || typeof sb !== "object") continue;
    if (sb.mode === "local" || sb.mode === "docker") merged.mode = sb.mode;
    if (typeof sb.image === "string" && sb.image.trim())
      merged.image = sb.image.trim();
    if (typeof sb.network === "boolean") merged.network = sb.network;
    if (Array.isArray(sb.mounts)) {
      merged.mounts = (sb.mounts as unknown[]).filter(
        (m): m is string => typeof m === "string",
      );
    }
  }
  return merged;
}

/**
 * Merge `model` role settings from the same three settings files as
 * permissions. Later files win for main/fast/plan; capability fields merge
 * per key with the same last-file-wins rule.
 */
export function loadModelSettings(
  repoRoot: string,
  homeDir: string = os.homedir(),
): ModelSettings {
  const files = [
    path.join(homeDir, ".codeagent", "settings.json"),
    path.join(repoRoot, ".codeagent", "settings.json"),
    path.join(repoRoot, ".codeagent", "settings.local.json"),
  ];
  const merged: ModelSettings = {};
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    const json = readJson(file);
    const model = json?.model;
    if (typeof model === "string") {
      const main = nonEmptyString(model);
      if (main) merged.main = main;
      continue;
    }
    if (!model || typeof model !== "object") continue;
    const record = model as Record<string, unknown>;
    for (const role of ["main", "fast", "plan"] as const) {
      const id = nonEmptyString(record[role]);
      if (id) merged[role] = id;
    }
    if (typeof record.smallModel === "boolean")
      merged.smallModel = record.smallModel;
    const caps = record.capabilities;
    if (caps && typeof caps === "object") {
      const capsRecord = caps as Record<string, unknown>;
      const contextWindow = positiveInt(capsRecord.contextWindow);
      const maxOutput = positiveInt(capsRecord.maxOutput);
      if (contextWindow !== undefined || maxOutput !== undefined) {
        merged.capabilities = {
          ...merged.capabilities,
          ...(contextWindow !== undefined ? { contextWindow } : {}),
          ...(maxOutput !== undefined ? { maxOutput } : {}),
        };
      }
    }
  }
  return merged;
}
