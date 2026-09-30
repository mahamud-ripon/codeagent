import { isCancel, select } from "@clack/prompts";
import { type SessionRecord } from "../../session/sessionManager.js";
import { icons, pc } from "./theme.js";

export type PermissionDecision = "yes" | "always" | "no";

export type PlanDecision = "accept" | "edit" | "reject";

/**
 * Plan-mode approval (AG-9): the agent's exit_plan_mode plan is shown and
 * the user must accept, edit, or reject before mutation tools unlock.
 * Fails closed when stdin is not a terminal (reject = stay in plan mode).
 */
export async function promptPlanApproval(plan: string): Promise<PlanDecision> {
  if (!process.stdin.isTTY) {
    return "reject";
  }

  const preview = plan.trim().slice(0, 3000) || "(no plan summary provided)";
  console.log("");
  console.log(`${pc.bold(pc.cyan("Proposed plan"))} ${pc.dim("(exit_plan_mode requires approval)")}`);
  console.log(pc.dim("─".repeat(50)));
  for (const line of preview.split("\n").slice(0, 40)) {
    console.log(`  ${line}`);
  }
  console.log(pc.dim("─".repeat(50)));

  const answer = await select({
    message: "Approve this plan?",
    options: [
      { value: "accept", label: `${pc.green("●")} Accept plan`, hint: "Unlock editing" },
      { value: "edit", label: `${pc.cyan("○")} Edit plan`, hint: "Revise, then unlock" },
      { value: "reject", label: `${pc.red("○")} Reject plan`, hint: "Stay in plan mode" },
    ],
  });

  if (isCancel(answer)) {
    return "reject";
  }

  return answer as PlanDecision;
}

/**
 * Interactive arrow-key permission prompt for command execution.
 * Fails closed when stdin is not a terminal. One-shot runs must pass
 * --allowedTools or --dangerously-skip-permissions. Cancellation maps to "no".
 */
export async function promptPermission(
  command: string,
  riskLevel: string = "Execute",
): Promise<PermissionDecision> {
  if (!process.stdin.isTTY) {
    return "no";
  }

  const shown = command.trim();

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
        label: `${pc.cyan("○")} Always allow this exact command for this session`,
        hint: shown,
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
 * Interactive rewind target picker (SS-2). Returns the 1-based turn index or null.
 */
export async function promptRewindSelect(
  turns: Array<{ index: number; label: string; timestamp: string; checkpointId?: string }>,
): Promise<number | null> {
  if (!process.stdin.isTTY || turns.length === 0) {
    return null;
  }
  const options = turns.map((t) => ({
    value: String(t.index),
    label: `Turn ${t.index}: ${(t.label || "untitled").slice(0, 60)}`,
    hint: `${t.timestamp}${t.checkpointId ? ` · ${t.checkpointId}` : ""}`,
  }));
  options.push({ value: "__cancel__", label: pc.dim("Cancel"), hint: "Keep current state" });
  console.log("");
  const chosen = await select({ message: "Rewind to which turn?", options });
  if (isCancel(chosen) || chosen === "__cancel__") return null;
  const n = Number(chosen);
  return Number.isInteger(n) ? n : null;
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
