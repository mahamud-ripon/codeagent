import { isCancel, select } from "@clack/prompts";
import { type SessionRecord } from "../../session/sessionManager.js";
import { colors, icons, pc } from "./theme.js";

export type PermissionDecision = "yes" | "always" | "no";

/**
 * Interactive arrow-key permission prompt for command execution.
 * Falls back safely to false if cancelled or if stdin is non-interactive.
 */
export async function promptPermission(
  command: string,
  riskLevel: string = "Execute",
): Promise<PermissionDecision> {
  if (!process.stdin.isTTY) {
    // Non-interactive fallback
    return "yes";
  }

  const prefix = command.trim().split(/\s+/)[0] || command;

  console.log("");
  const answer = await select({
    message: `${pc.yellow(icons.warn)} Execute terminal command: ${pc.bold(command)}`,
    options: [
      {
        value: "yes",
        label: `${pc.green("●")} Yes, execute this command`,
        hint: `Risk: ${riskLevel}`,
      },
      {
        value: "always",
        label: `${pc.cyan("○")} Always allow "${prefix}" for this session`,
        hint: `Auto-approve matching "${prefix} *" commands`,
      },
      {
        value: "no",
        label: `${pc.red("○")} No, deny this command`,
        hint: "Agent will proceed without running it",
      },
    ],
  });

  if (isCancel(answer)) {
    return "no";
  }

  return answer as PermissionDecision;
}

/**
 * Interactive session selection menu.
 */
export async function promptSessionSelect(
  sessions: SessionRecord[],
  activeId?: string,
): Promise<string | null> {
  if (!process.stdin.isTTY || sessions.length === 0) {
    return null;
  }

  const options = sessions.map((s, idx) => {
    const isActive = s.id === activeId;
    const marker = isActive ? pc.green(" [Active]") : "";
    return {
      value: s.id,
      label: `${idx + 1}. ${s.title || "Untitled"}${marker}`,
      hint: `${s.id} · ${s.turnCount} turns`,
    };
  });

  options.push({
    value: "__cancel__",
    label: pc.dim("Cancel"),
    hint: "Keep current session",
  });

  console.log("");
  const chosen = await select({
    message: "Select a session to resume:",
    options,
  });

  if (isCancel(chosen) || chosen === "__cancel__") {
    return null;
  }

  return chosen as string;
}
