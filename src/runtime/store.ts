import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import type {
  RuntimeEvent,
  SessionSnapshot,
  SessionStore,
} from "./contracts.js";

export function runtimeHome(): string {
  return (
    process.env.CODEAGENT_RUNTIME_HOME ??
    path.join(os.homedir(), ".codeagent", "runtime", "v1")
  );
}
export function safeId(id: string): string {
  if (!/^[a-zA-Z0-9_-]{1,160}$/.test(id))
    throw new Error("Invalid runtime identifier");
  return id;
}
export function redact(text: string): string {
  for (const [name, value] of Object.entries(process.env)) {
    if (
      value &&
      value.length >= 8 &&
      /(?:api[_-]?key|password|secret|token)/i.test(name)
    )
      text = text.split(value).join("[REDACTED]");
  }
  return text
    .replace(/\b(?:sk-|gsk_|AIza)[A-Za-z0-9_-]{12,}/g, "[REDACTED]")
    .replace(
      /(authorization\s*[:=]\s*(?:bearer\s+)?)[^\s"']+/gi,
      "$1[REDACTED]",
    )
    .replace(
      /((?:api[_-]?key|password|token|secret)\s*[=:]\s*)["']?[^\s,"'}]+/gi,
      "$1[REDACTED]",
    );
}
/** Hold unfinished words so credentials split across provider chunks are redacted together. */
export class StreamingRedactor {
  private pending = "";
  push(chunk: string, final = false): string {
    this.pending += chunk;
    let end = final ? this.pending.length : this.pending.search(/\S+$/);
    if (end < 0) end = this.pending.length;
    if (
      !final &&
      /authorization|api[_-]?key|password|secret|token/i.test(this.pending)
    )
      end = this.pending.lastIndexOf("\n") + 1;
    if (!end && this.pending.length > 32768) {
      this.pending = "";
      return "[REDACTED oversized fragment]";
    }
    const safe = redact(this.pending.slice(0, end));
    this.pending = this.pending.slice(end);
    return safe;
  }
}
export function redactValue(value: unknown): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        /^(?:api[_-]?key|authorization|password|secret|token)$/i.test(key)
          ? "[REDACTED]"
          : redactValue(item),
      ]),
    );
  return value;
}
export function atomicJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomUUID()}.tmp`;
  const fd = fs.openSync(tmp, "wx", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(value));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}
/** Owned by one supervisor. The supervisor lock prevents multiple writers. */
export class JournalStore implements SessionStore {
  private lastSync = new Map<string, number>();
  private cache = new Map<
    string,
    {
      size: number;
      mtime: number;
      completeBytes: number;
      events: RuntimeEvent[];
    }
  >();
  constructor(public readonly root = runtimeHome()) {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  }
  directory(id: string): string {
    const dir = path.join(this.root, "sessions", safeId(id));
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }
  private readEvents(id: string) {
    const file = path.join(this.directory(id), "events.jsonl");
    const stat = fs.existsSync(file) ? fs.statSync(file) : undefined;
    const cached = this.cache.get(id);
    if (cached && cached.size === stat?.size && cached.mtime === stat.mtimeMs)
      return cached;
    const bytes = stat ? fs.readFileSync(file) : Buffer.alloc(0);
    // The newline is the commit marker, even when an interrupted tail parses as JSON.
    const completeBytes = bytes.lastIndexOf(10) + 1;
    const events: RuntimeEvent[] = [];
    for (const line of bytes
      .subarray(0, completeBytes)
      .toString("utf8")
      .split("\n")) {
      if (!line) continue;
      try {
        const e = JSON.parse(line) as RuntimeEvent;
        if (
          e.version !== 1 ||
          e.sessionId !== id ||
          e.sequence !== events.length + 1
        )
          throw new Error("Invalid journal sequence");
        events.push(e);
      } catch (error) {
        throw new Error(`Corrupt journal: ${String(error)}`);
      }
    }
    const entry = {
      size: bytes.length,
      mtime: stat?.mtimeMs ?? 0,
      completeBytes,
      events,
    };
    this.cache.set(id, entry);
    return entry;
  }
  events(id: string, after = 0): RuntimeEvent[] {
    return structuredClone(
      this.readEvents(id).events.filter((e) => e.sequence > after),
    );
  }
  append(
    event: Omit<RuntimeEvent, "version" | "sequence" | "timestamp">,
  ): RuntimeEvent {
    const existing = this.readEvents(event.sessionId);
    const e: RuntimeEvent = {
      ...event,
      data: redactValue(event.data) as Record<string, unknown>,
      version: 1,
      sequence: existing.events.length + 1,
      timestamp: new Date().toISOString(),
    };
    const file = path.join(this.directory(event.sessionId), "events.jsonl");
    if (existing.completeBytes !== existing.size)
      fs.truncateSync(file, existing.completeBytes);
    const fd = fs.openSync(file, "a", 0o600);
    try {
      fs.writeSync(fd, JSON.stringify(e) + "\n");
      // Streaming deltas group-commit at most every 100ms. Every other event
      // durably commits itself and all preceding deltas, including the final tail.
      const delta = ["text_delta", "thinking_delta", "tool_output_delta"].includes(e.type);
      const now = Date.now();
      if (!delta || now - (this.lastSync.get(event.sessionId) ?? 0) >= 100) {
        fs.fsyncSync(fd);
        this.lastSync.set(event.sessionId, now);
      }
    } finally {
      fs.closeSync(fd);
    }
    const stat = fs.statSync(file);
    existing.events.push(e);
    existing.size = existing.completeBytes = stat.size;
    existing.mtime = stat.mtimeMs;
    return structuredClone(e);
  }
  save(snapshot: SessionSnapshot): void {
    atomicJson(
      path.join(this.directory(snapshot.id), "snapshot.json"),
      redactValue(snapshot),
    );
  }
  load(id: string): SessionSnapshot | undefined {
    const file = path.join(this.directory(id), "snapshot.json");
    if (!fs.existsSync(file)) return undefined;
    const s = JSON.parse(fs.readFileSync(file, "utf8")) as SessionSnapshot;
    if (s.version !== 1 || s.id !== id)
      throw new Error("Unsupported session snapshot");
    for (const event of this.events(id, s.sequence)) {
      if (event.agentId !== "coordinator") {
        s.sequence = event.sequence;
        continue;
      }
      if (event.type === "message")
        s.messages.push(event.data.message as (typeof s.messages)[number]);
      if (event.type === "status")
        s.status = event.data.status as typeof s.status;
      if (event.type === "tasks") s.tasks = event.data.tasks as typeof s.tasks;
      if (event.type === "verification")
        s.verifications.push(
          event.data.record as (typeof s.verifications)[number],
        );
      if (event.type === "done") {
        s.result = event.data;
        s.status = event.data.status as typeof s.status;
      }
      if (event.runId) s.runId = event.runId;
      s.sequence = event.sequence;
    }
    return s;
  }
  artifact(id: string, text: string): string {
    const clean = redact(text);
    const name = createHash("sha256").update(clean).digest("hex") + ".txt";
    const dir = path.join(this.directory(id), "artifacts");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) fs.writeFileSync(file, clean, { mode: 0o600 });
    return name;
  }
  list(): SessionSnapshot[] {
    const dir = path.join(this.root, "sessions");
    if (!fs.existsSync(dir)) return [];
    const snapshots: SessionSnapshot[] = [];
    for (const id of fs.readdirSync(dir)) {
      try {
        safeId(id);
        const snapshot = this.load(id);
        if (snapshot) snapshots.push(snapshot);
        else console.warn(`Skipping session ${JSON.stringify(id)}: missing snapshot`);
      } catch (error) {
        console.warn(`Skipping session ${JSON.stringify(id)}: ${String(error)}`);
      }
    }
    return snapshots;
  }
}
