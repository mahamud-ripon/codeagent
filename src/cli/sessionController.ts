/**
 * F-13 split (2/3): session controller helpers (pure, no readline).
 * The live REPL in repl.ts owns I/O; these own session state transitions.
 */

export interface SessionTransition {
  kind: "new" | "resume" | "clear" | "none";
  sessionId?: string;
}

export function transitionForCommand(cmd: string, args: string): SessionTransition {
  const c = cmd.toLowerCase();
  if (c === "new") return { kind: "new" };
  if (c === "resume" || c === "continue") return { kind: "resume", sessionId: args || undefined };
  if (c === "clear") return { kind: "clear" };
  if (c === "session" && args.toLowerCase().startsWith("new")) return { kind: "new" };
  if (c === "session" && args.toLowerCase().startsWith("resume")) {
    return { kind: "resume", sessionId: args.slice(6).trim() || undefined };
  }
  return { kind: "none" };
}
