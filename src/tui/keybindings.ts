import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * UI-13: vim mode + custom keybindings file.
 * Zero-dep companion to tui/next.ts: the readline REPL stays the default,
 * --ui=next opts into streaming; vim mode toggles modal input handling.
 * File: ~/.codeagent/keybindings.json  { "vim": true, "bindings": {...} }
 */

export interface Keybindings {
  vim?: boolean;
  bindings?: Record<string, string>;
}

export function keybindingsPath(homeDir: string = os.homedir()): string {
  return path.join(homeDir, ".codeagent", "keybindings.json");
}

export function loadKeybindings(homeDir: string = os.homedir()): Keybindings {
  try {
    const raw = fs.readFileSync(keybindingsPath(homeDir), "utf8");
    const parsed = JSON.parse(raw) as Keybindings;
    return { vim: !!parsed.vim, bindings: parsed.bindings ?? {} };
  } catch {
    return {};
  }
}

export function isVimMode(homeDir: string = os.homedir()): boolean {
  if (process.env.CODEAGENT_VIM === "1") return true;
  if (process.env.CODEAGENT_VIM === "0") return false;
  return loadKeybindings(homeDir).vim === true;
}

/** Minimal vim-state machine for the input line (normal/insert). Pure. */
export type VimState = "insert" | "normal";

export function vimNextState(state: VimState, key: string): VimState {
  if (state === "insert" && key === "\x1b") return "normal";
  if (state === "normal" && (key === "i" || key === "a")) return "insert";
  return state;
}

export function describeKeybindings(kb: Keybindings): string {
  const lines = [`vim: ${kb.vim ? "on" : "off"}`];
  for (const [k, v] of Object.entries(kb.bindings ?? {})) lines.push(`${k} → ${v}`);
  return lines.join("\n");
}
