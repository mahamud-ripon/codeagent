import type { z } from "zod";
import type { ToolExecutionContext } from "../tools/index.js";

export const PROTOCOL_VERSION = 1;
export type Lifecycle =
  | "running"
  | "waiting_for_approval"
  | "waiting_for_input"
  | "paused"
  | "completed"
  | "blocked"
  | "failed"
  | "cancelled";
export type Message =
  | { kind: "text"; role: "system" | "user" | "assistant"; text: string }
  | { kind: "call"; id: string; name: string; arguments: string }
  | { kind: "result"; id: string; text: string }
  | { kind: "provider"; payload: Record<string, unknown> };
export interface RuntimeEvent {
  version: 1;
  sessionId: string;
  runId: string;
  agentId: string;
  sequence: number;
  correlationId: string;
  timestamp: string;
  type: string;
  data: Record<string, unknown>;
}
export interface TaskRecord {
  id: string;
  objective: string;
  acceptance: string[];
  dependencies: string[];
  owner?: string;
  status: "pending" | "running" | "completed" | "blocked" | "failed";
  artifacts: string[];
  result?: string;
}
export interface VerificationRecord {
  id: string;
  command: string;
  exitCode: number;
  output: string;
  artifact?: string;
  workspaceHash: string;
  timestamp: string;
  valid: boolean;
}
export interface SessionSnapshot {
  version: 1;
  id: string;
  repoRoot: string;
  sequence: number;
  status: Lifecycle;
  messages: Message[];
  tasks: TaskRecord[];
  verifications: VerificationRecord[];
  runId?: string;
  result?: Record<string, unknown>;
  provenance?: string;
}
export interface SessionStore {
  append(
    event: Omit<RuntimeEvent, "version" | "sequence" | "timestamp">,
  ): RuntimeEvent;
  events(sessionId: string, after?: number): RuntimeEvent[];
  save(snapshot: SessionSnapshot): void;
  load(sessionId: string): SessionSnapshot | undefined;
  artifact(sessionId: string, text: string): string;
}
export interface ToolDefinition {
  name: string;
  description: string;
  schema: z.ZodType;
  effect: "read" | "write" | "command" | "coordination" | "external";
  concurrency: "shared" | "exclusive";
  recovery: "repeatable" | "reconcile";
  execute(
    repoRoot: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    context?: ToolExecutionContext,
  ): Promise<string>;
}
export interface BudgetLimits {
  calls: number;
  tokens?: number;
  costUsd?: number;
}
export class RunBudget {
  calls = 0;
  input = 0;
  output = 0;
  cachedInput = 0;
  costUsd: number | null = 0;
  constructor(public readonly limits: BudgetLimits) {}
  reserve(): void {
    if (
      this.calls >= this.limits.calls ||
      (this.limits.tokens !== undefined &&
        this.input + this.output >= this.limits.tokens) ||
      (this.limits.costUsd !== undefined &&
        (this.costUsd === null || this.costUsd >= this.limits.costUsd))
    )
      throw new Error(
        "Run budget exhausted (or pricing unavailable for a cost-limited run).",
      );
    this.calls++;
  }
  add(u?: {
    input: number;
    output: number;
    cachedInput?: number;
    costUsd?: number;
  }): void {
    if (!u) {
      this.costUsd = null;
      return;
    }
    this.input += u.input;
    this.output += u.output;
    this.cachedInput += u.cachedInput ?? 0;
    this.costUsd =
      u.costUsd === undefined || this.costUsd === null
        ? null
        : this.costUsd + u.costUsd;
  }
}
export function toProvider(messages: Message[]): unknown[] {
  return messages.map((m) =>
    m.kind === "text"
      ? { role: m.role, content: m.text }
      : m.kind === "call"
        ? {
            type: "function_call",
            call_id: m.id,
            name: m.name,
            arguments: m.arguments,
          }
        : m.kind === "result"
          ? { type: "function_call_output", call_id: m.id, output: m.text }
          : m.payload,
  );
}
export function fromProvider(items: unknown[]): Message[] {
  return items
    .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
    .map((x) => {
      if (x.type === "function_call")
        return {
          kind: "call",
          id: String(x.call_id),
          name: String(x.name),
          arguments: String(x.arguments ?? "{}"),
        };
      if (x.type === "function_call_output")
        return {
          kind: "result",
          id: String(x.call_id),
          text: String(x.output ?? ""),
        };
      if (
        ["system", "user", "assistant"].includes(String(x.role)) &&
        typeof x.content === "string"
      )
        return { kind: "text", role: x.role as "user", text: x.content };
      return { kind: "provider", payload: x };
    });
}
