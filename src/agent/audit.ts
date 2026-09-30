import fs from "node:fs";
import path from "node:path";

/**
 * Append-only audit log (SF-8).
 *
 * Every tool call, permission decision, and plan verdict is appended as one
 * JSON line to `<repo>/.codeagent/audit.jsonl`. Best-effort by design:
 * logging never throws and never blocks the agent — a read-only checkout
 * simply records nothing.
 */

export type AuditKind = "tool" | "permission" | "plan" | "run";

export interface AuditEvent {
  kind: AuditKind;
  /** Tool name, or what the decision was about. */
  tool?: string;
  /** Redacted arguments (secrets stripped). */
  args?: unknown;
  ok?: boolean;
  /** Elapsed ms for tool calls. */
  ms?: number;
  /** allow | deny | ask(+handler verdict) etc. */
  decision?: string;
  detail?: string;
}

const SECRET_KEY = /key|token|secret|password|passwd|auth|credential|session/i;

function redact(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY.test(k) ? "[redacted]" : redact(v, depth + 1);
    }
    return out;
  }
  if (typeof value === "string" && value.length > 2000) return `${value.slice(0, 2000)}[...truncated]`;
  return value;
}

export function auditFile(repoRoot: string): string {
  return path.join(path.resolve(repoRoot), ".codeagent", "audit.jsonl");
}

/** Append one event. Never throws. */
export function logAudit(repoRoot: string, event: AuditEvent): void {
  try {
    const file = auditFile(repoRoot);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      repo: path.resolve(repoRoot),
      kind: event.kind,
      ...(event.tool !== undefined ? { tool: event.tool } : {}),
      ...(event.args !== undefined ? { args: redact(event.args) } : {}),
      ...(event.ok !== undefined ? { ok: event.ok } : {}),
      ...(event.ms !== undefined ? { ms: event.ms } : {}),
      ...(event.decision !== undefined ? { decision: event.decision } : {}),
      ...(event.detail !== undefined ? { detail: String(event.detail).slice(0, 2000) } : {}),
    });
    fs.appendFileSync(file, `${line}\n`);
  } catch {
    // Audit is observational — a failure here must never break the run.
  }
}
