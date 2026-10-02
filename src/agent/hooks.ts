import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

/**
 * EX-3: user hooks SessionStart, UserPromptSubmit, PreToolUse, PostToolUse,
 * Stop, PreCompact. Each hook is a shell command receiving JSON on stdin.
 * Existing stopHooks.ts stays the built-in Stop hook; these are user hooks.
 */

export type HookName =
  | "SessionStart"
  | "UserPromptSubmit"
  | "PreToolUse"
  | "PostToolUse"
  | "Stop"
  | "PreCompact";

export interface HookDef {
  enforcement?: boolean;
  timeoutMs?: number;
  matcher?: string;
  command: string;
}

export type HookConfig = Partial<Record<HookName, HookDef[]>>;

function matcherHit(matcher: string | undefined, target: string): boolean {
  if (!matcher) return true;
  try {
    return new RegExp(matcher).test(target);
  } catch {
    return matcher.split("|").some((p) => target.includes(p.trim()));
  }
}

export async function runHooks(
  config: HookConfig | undefined,
  name: HookName,
  payload: Record<string, unknown>,
  opts?: { timeoutMs?: number },
): Promise<Array<{ command: string; stdout: string }>> {
  const defs = config?.[name] ?? [];
  const target = String((payload.tool ?? payload.matcher ?? "") as string);
  const out: Array<{ command: string; stdout: string }> = [];
  for (const def of defs) {
    if (!matcherHit(def.matcher, target)) continue;
    try {
      const proc = execAsync(def.command, {
        timeout: opts?.timeoutMs ?? 15_000,
        maxBuffer: 512 * 1024,
      });
      const child = proc.child;
      if (child?.stdin?.writable) {
        child.stdin.write(JSON.stringify({ hook: name, ...payload }));
        child.stdin.end();
      }
      const { stdout } = await proc;
      out.push({ command: def.command, stdout: stdout.slice(0, 4000) });
    } catch {
      // Hooks never block the run on failure.
    }
  }
  return out;
}

export function loadHookConfig(settings: { hooks?: HookConfig }): HookConfig {
  return settings.hooks ?? {};
}
