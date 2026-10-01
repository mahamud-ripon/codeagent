import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Lightweight checkpoint reference persisted with the session (SS-1). Git refs persist separately. */
export interface CheckpointRef {
  id: string;
  timestamp: number;
  label: string;
  commitHash: string;
}

/** One user turn: where history started/ended and which checkpoint guards it (SS-2). */
export interface TurnSnapshot {
  index: number;
  timestamp: string;
  label: string;
  historyStart: number;
  historyLength: number;
  checkpointId?: string;
}

export interface SessionRecord {
  id: string;
  title: string;
  repoRoot: string;
  createdAt: string;
  updatedAt: string;
  model?: string;
  provider?: string;
  baseURL?: string;
  turnCount: number;
  history: unknown[];
  modifiedFiles: string[];
  checkpoints?: CheckpointRef[];
  turns?: TurnSnapshot[];
  /** Cumulative usage — persisted so /cost survives resume (Claude Code parity). */
  usage?: { input: number; output: number; costUsd: number; cachedInput?: number };
}

export function sessionsDir(home: string = os.homedir()): string {
  return path.join(home, ".codeagent", "sessions");
}

function sessionJsonPath(id: string, home: string): string {
  return path.join(sessionsDir(home), `${id}.json`);
}

function sessionJsonlPath(id: string, home: string): string {
  return path.join(sessionsDir(home), `${id}.jsonl`);
}

export function generateSessionId(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const y = now.getFullYear();
  const m = pad(now.getMonth() + 1);
  const d = pad(now.getDate());
  const h = pad(now.getHours());
  const min = pad(now.getMinutes());
  const s = pad(now.getSeconds());
  const rand = Math.random().toString(36).slice(2, 6);
  return `ses_${y}${m}${d}_${h}${min}${s}_${rand}`;
}

export function formatTimeAgo(isoString: string): string {
  const date = new Date(isoString);
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (isNaN(seconds) || seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function createSession(
  repoRoot: string,
  initial?: Partial<SessionRecord>,
): SessionRecord {
  const now = new Date().toISOString();
  return {
    id: initial?.id ?? generateSessionId(),
    title: initial?.title ?? "New session",
    repoRoot: path.resolve(repoRoot),
    createdAt: initial?.createdAt ?? now,
    updatedAt: initial?.updatedAt ?? now,
    model: initial?.model,
    provider: initial?.provider,
    baseURL: initial?.baseURL,
    turnCount: initial?.turnCount ?? 0,
    history: initial?.history ?? [],
    modifiedFiles: initial?.modifiedFiles ?? [],
    checkpoints: initial?.checkpoints ?? [],
    turns: initial?.turns ?? [],
  };
}

function normalizeRecord(raw: unknown, fallbackRepoRoot: string): SessionRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string") return null;
  const now = new Date().toISOString();
  const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
  const asCheckpoints = (v: unknown): CheckpointRef[] => {
    if (!Array.isArray(v)) return [];
    return v.filter(
      (c): c is CheckpointRef =>
        !!c && typeof c === "object" && typeof (c as CheckpointRef).id === "string",
    );
  };
  const asTurns = (v: unknown): TurnSnapshot[] => {
    if (!Array.isArray(v)) return [];
    return v.filter(
      (t): t is TurnSnapshot =>
        !!t && typeof t === "object" && typeof (t as TurnSnapshot).index === "number",
    );
  };
  const asUsage = (v: unknown): SessionRecord["usage"] => {
    if (!v || typeof v !== "object") return undefined;
    const u = v as Record<string, unknown>;
    const num = (x: unknown): number => (typeof x === "number" && Number.isFinite(x) ? x : 0);
    if (u.input === undefined && u.output === undefined && u.costUsd === undefined) return undefined;
    return { input: num(u.input), output: num(u.output), costUsd: num(u.costUsd), cachedInput: num(u.cachedInput) };
  };
  return {
    id: r.id,
    title: typeof r.title === "string" && r.title ? r.title : "New session",
    repoRoot: typeof r.repoRoot === "string" ? r.repoRoot : path.resolve(fallbackRepoRoot),
    createdAt: typeof r.createdAt === "string" ? r.createdAt : now,
    updatedAt: typeof r.updatedAt === "string" ? r.updatedAt : now,
    model: typeof r.model === "string" ? r.model : undefined,
    provider: typeof r.provider === "string" ? r.provider : undefined,
    baseURL: typeof r.baseURL === "string" ? r.baseURL : undefined,
    turnCount: typeof r.turnCount === "number" ? r.turnCount : 0,
    history: asArray(r.history),
    modifiedFiles: asArray(r.modifiedFiles).filter((f): f is string => typeof f === "string"),
    checkpoints: asCheckpoints(r.checkpoints),
    turns: asTurns(r.turns),
    usage: asUsage(r.usage),
  };
}

function readJsonFile(file: string): unknown | null {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  } catch {
    // Corrupt JSON (crash mid-write before crash-safe path existed):
    // quarantine instead of silently treating as missing.
    try {
      const bad = `${file}.corrupt.${Date.now()}`;
      fs.renameSync(file, bad);
    } catch {
      // ignore quarantine failure
    }
    return null;
  }
}

/** Crash-safe write: tmp file + fsync + rename so a crash never leaves half-written JSON. */
function writeJsonCrashSafe(file: string, value: unknown): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
  try {
    const fd = fs.openSync(tmp, "r");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // fsync best-effort (Windows / exotic FS).
  }
  fs.renameSync(tmp, file);
}

/** fsync a file after append so a crash doesn't lose the last turn. Best-effort. */
function fsyncFile(file: string): void {
  try {
    const fd = fs.openSync(file, "r");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // ignore
  }
}

/**
 * Cross-process file lock (Windows-safe): exclusive .lock dir creation.
 * Returns a release fn. Contended writers retry briefly; on timeout they
 * proceed without the lock (never deadlock the agent).
 */
function acquireSessionLock(id: string, home: string, timeoutMs = 2000): () => void {
  const lockPath = path.join(sessionsDir(home), `${id}.lock`);
  const start = Date.now();
  for (;;) {
    try {
      fs.mkdirSync(lockPath);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try {
          fs.rmdirSync(lockPath);
        } catch {
          // ignore
        }
      };
    } catch {
      if (Date.now() - start > timeoutMs) return () => undefined;
      const end = Date.now() + 50;
      while (Date.now() < end) {
        // tiny busy-wait to avoid setTimeout in sync path
      }
    }
  }
}

type JsonlInitLine = { v: 1; kind: "init"; record: SessionRecord };
type JsonlTurnLine = {
  v: 1;
  kind: "turn";
  index: number;
  timestamp: string;
  label: string;
  historyStart: number;
  historyLength: number;
  historyAppend: unknown[];
  turnCount: number;
  checkpoint?: CheckpointRef;
  title?: string;
  modifiedFilesAppend?: string[];
  model?: string;
  provider?: string;
  baseURL?: string;
  usageAppend?: { input?: number; output?: number; costUsd?: number; cachedInput?: number };
};
type JsonlSaveLine = { v: 1; kind: "save"; updatedAt: string; patch: Partial<SessionRecord> };
type JsonlRewriteLine = { v: 1; kind: "rewrite"; updatedAt: string; history: unknown[]; turnCount: number };
type JsonlLine = JsonlInitLine | JsonlTurnLine | JsonlSaveLine | JsonlRewriteLine;

function parseJsonlLines(raw: string): JsonlLine[] {
  const out: JsonlLine[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const v = JSON.parse(t) as JsonlLine;
      if (v && typeof v === "object" && (v as { v?: number }).v === 1) out.push(v);
    } catch {
      // A torn last line from a crash is skipped; earlier lines still replay.
    }
  }
  return out;
}

function replayJsonl(lines: JsonlLine[]): SessionRecord | null {
  let record: SessionRecord | null = null;
  for (const line of lines) {
    if (line.kind === "init") {
      record = normalizeRecord(line.record, process.cwd());
    } else if (line.kind === "turn") {
      if (!record) continue;
      record.history = [...record.history, ...line.historyAppend];
      record.turnCount = line.turnCount;
      record.updatedAt = line.timestamp;
      if (line.checkpoint) {
        record.checkpoints = [...(record.checkpoints ?? [])];
        if (!record.checkpoints.some((c) => c.id === line.checkpoint!.id)) {
          record.checkpoints.push(line.checkpoint);
        }
      }
      if (typeof line.title === "string" && line.title) record.title = line.title;
      if (line.modifiedFilesAppend) {
        for (const f of line.modifiedFilesAppend) {
          if (!record.modifiedFiles.includes(f)) record.modifiedFiles.push(f);
        }
      }
      if (line.model !== undefined) record.model = line.model;
      if (line.provider !== undefined) record.provider = line.provider;
      if (line.baseURL !== undefined) record.baseURL = line.baseURL;
      if (line.usageAppend) {
        const cur = record.usage ?? { input: 0, output: 0, costUsd: 0, cachedInput: 0 };
        const num = (x: unknown): number => (typeof x === "number" && Number.isFinite(x) ? x : 0);
        record.usage = {
          input: cur.input + num(line.usageAppend.input),
          output: cur.output + num(line.usageAppend.output),
          costUsd: cur.costUsd + num(line.usageAppend.costUsd),
          cachedInput: (cur.cachedInput ?? 0) + num(line.usageAppend.cachedInput),
        };
      }
      const snap: TurnSnapshot = {
        index: line.index,
        timestamp: line.timestamp,
        label: line.label,
        historyStart: line.historyStart,
        historyLength: line.historyLength,
        checkpointId: line.checkpoint?.id,
      };
      record.turns = [...(record.turns ?? []).filter((t) => t.index !== line.index), snap].sort(
        (a, b) => a.index - b.index,
      );
    } else if (line.kind === "save") {
      if (!record) continue;
      const patch = normalizeRecord({ ...record, ...line.patch }, record.repoRoot);
      if (patch) {
        // Keep replayed history/turns unless the patch explicitly replaces them.
        record = { ...patch, updatedAt: line.updatedAt };
      }
    } else if ((line as { kind: string }).kind === "rewrite") {
      if (!record) continue;
      const rw = line as JsonlRewriteLine;
      record.history = Array.isArray(rw.history) ? rw.history : record.history;
      record.turnCount = typeof rw.turnCount === "number" ? rw.turnCount : record.turnCount;
      record.updatedAt = rw.updatedAt;
    }
  }
  return record;
}

function ensureJsonlExists(record: SessionRecord, home: string): void {
  const jsonl = sessionJsonlPath(record.id, home);
  if (fs.existsSync(jsonl)) return;
  // Migrate legacy JSON: if a .json snapshot exists, seed the log from it so
  // no history is lost; otherwise seed from the in-memory record.
  const legacy = readJsonFile(sessionJsonPath(record.id, home));
  const seed = normalizeRecord(legacy ?? record, record.repoRoot) ?? record;
  const init: JsonlInitLine = { v: 1, kind: "init", record: seed };
  try {
    fs.mkdirSync(path.dirname(jsonl), { recursive: true });
    fs.writeFileSync(jsonl, JSON.stringify(init) + "\n", "utf8");
    fsyncFile(jsonl);
  } catch {
    // Best-effort: JSON snapshot below still persists.
  }
}

export function saveSession(
  record: SessionRecord,
  home: string = os.homedir(),
): string {
  const dir = sessionsDir(home);
  fs.mkdirSync(dir, { recursive: true });
  record.updatedAt = new Date().toISOString();
  record.checkpoints = record.checkpoints ?? [];
  record.turns = record.turns ?? [];
  const file = sessionJsonPath(record.id, home);
  const release = acquireSessionLock(record.id, home);
  try {
    writeJsonCrashSafe(file, record);
    ensureJsonlExists(record, home);
    const save: JsonlSaveLine = {
      v: 1,
      kind: "save",
      updatedAt: record.updatedAt,
      patch: {
        title: record.title,
        turnCount: record.turnCount,
        model: record.model,
        provider: record.provider,
        baseURL: record.baseURL,
        modifiedFiles: record.modifiedFiles,
        checkpoints: record.checkpoints,
        turns: record.turns,
        usage: record.usage,
      },
    };
    fs.appendFileSync(sessionJsonlPath(record.id, home), JSON.stringify(save) + "\n", "utf8");
    fsyncFile(sessionJsonlPath(record.id, home));
  } catch {
    // Best-effort.
  } finally {
    release();
  }
  return file;
}

export interface AppendTurnArgs {
  label: string;
  historyAppend: unknown[];
  historyStart: number;
  checkpoint?: CheckpointRef;
  title?: string;
  modifiedFilesAppend?: string[];
  model?: string;
  provider?: string;
  baseURL?: string;
  /** Per-turn usage delta to fold into the persisted cumulative totals. */
  usageAppend?: { input?: number; output?: number; costUsd?: number; cachedInput?: number };
}

/**
 * Append one user turn to the JSONL log (SS-3) and fold it into the in-memory
 * record. Crash-safe: a single appendFileSync line; torn tails are skipped on load.
 */
export function appendSessionTurn(
  record: SessionRecord,
  args: AppendTurnArgs,
  home: string = os.homedir(),
): TurnSnapshot {
  ensureJsonlExists(record, home);
  const existing = record.turns ?? [];
  const maxIndex = existing.reduce((m, t) => Math.max(m, t.index ?? 0), existing.length);
  const index = Math.max(existing.length, maxIndex) + 1;
  const timestamp = new Date().toISOString();
  const historyLength = args.historyStart + args.historyAppend.length;
  const line: JsonlTurnLine = {
    v: 1,
    kind: "turn",
    index,
    timestamp,
    label: args.label,
    historyStart: args.historyStart,
    historyLength,
    historyAppend: args.historyAppend,
    turnCount: record.turnCount + 1,
    checkpoint: args.checkpoint,
    title: args.title,
    modifiedFilesAppend: args.modifiedFilesAppend,
    model: args.model,
    provider: args.provider,
    baseURL: args.baseURL,
    usageAppend: args.usageAppend,
  };
  const release = acquireSessionLock(record.id, home);
  try {
    fs.mkdirSync(sessionsDir(home), { recursive: true });
    fs.appendFileSync(sessionJsonlPath(record.id, home), JSON.stringify(line) + "\n", "utf8");
    fsyncFile(sessionJsonlPath(record.id, home));
  } catch {
    // Best-effort: in-memory state below still advances.
  } finally {
    release();
  }
  record.history = [...record.history, ...args.historyAppend];
  record.turnCount += 1;
  record.updatedAt = timestamp;
  if (args.checkpoint) {
    record.checkpoints = [...(record.checkpoints ?? [])];
    if (!record.checkpoints.some((c) => c.id === args.checkpoint!.id)) {
      record.checkpoints.push(args.checkpoint);
    }
  }
  if (args.title) record.title = args.title;
  if (args.modifiedFilesAppend) {
    for (const f of args.modifiedFilesAppend) {
      if (!record.modifiedFiles.includes(f)) record.modifiedFiles.push(f);
    }
  }
  if (args.model !== undefined) record.model = args.model;
  if (args.provider !== undefined) record.provider = args.provider;
  if (args.baseURL !== undefined) record.baseURL = args.baseURL;
  if (args.usageAppend) {
    const cur = record.usage ?? { input: 0, output: 0, costUsd: 0, cachedInput: 0 };
    const num = (x: unknown): number => (typeof x === "number" && Number.isFinite(x) ? x : 0);
    record.usage = {
      input: cur.input + num(args.usageAppend.input),
      output: cur.output + num(args.usageAppend.output),
      costUsd: cur.costUsd + num(args.usageAppend.costUsd),
      cachedInput: (cur.cachedInput ?? 0) + num(args.usageAppend.cachedInput),
    };
  }
  const snap: TurnSnapshot = {
    index,
    timestamp,
    label: args.label,
    historyStart: args.historyStart,
    historyLength,
    checkpointId: args.checkpoint?.id,
  };
  record.turns = [...(record.turns ?? []), snap];
  // Keep the compat JSON snapshot fresh (crash-safe rewrite).
  try {
    writeJsonCrashSafe(sessionJsonPath(record.id, home), record);
  } catch {
    // Best-effort.
  }
  return snap;
}

export function loadSession(
  id: string,
  home: string = os.homedir(),
): SessionRecord | null {
  const dir = sessionsDir(home);
  const jsonl = path.join(dir, `${id}.jsonl`);
  if (fs.existsSync(jsonl)) {
    try {
      const lines = parseJsonlLines(fs.readFileSync(jsonl, "utf8"));
      const replayed = replayJsonl(lines);
      if (replayed) return replayed;
    } catch {
      // Fall through to JSON.
    }
  }
  const json = path.join(dir, `${id}.json`);
  const raw = readJsonFile(json);
  const record = raw ? normalizeRecord(raw, process.cwd()) : null;
  if (record && !fs.existsSync(jsonl)) {
    // Migrate legacy JSON sessions to JSONL on first load (SS-3).
    ensureJsonlExists(record, home);
  }
  return record;
}

function collectSessionIds(home: string): string[] {
  const dir = sessionsDir(home);
  if (!fs.existsSync(dir)) return [];
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const ids = new Set<string>();
  for (const f of files) {
    if (f.endsWith(".jsonl")) ids.add(f.slice(0, -".jsonl".length));
    else if (f.endsWith(".json")) ids.add(f.slice(0, -".json".length));
  }
  return [...ids];
}

export function listSessions(
  repoRoot?: string,
  home: string = os.homedir(),
): SessionRecord[] {
  const sessions: SessionRecord[] = [];
  for (const id of collectSessionIds(home)) {
    const record = loadSession(id, home);
    if (record && typeof record.id === "string") {
      if (!repoRoot || path.resolve(record.repoRoot) === path.resolve(repoRoot)) {
        sessions.push(record);
      }
    }
  }

  return sessions.sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  );
}

export function deleteSession(
  id: string,
  home: string = os.homedir(),
): boolean {
  const dir = sessionsDir(home);
  let deleted = false;
  for (const file of [path.join(dir, `${id}.json`), path.join(dir, `${id}.jsonl`)]) {
    if (!fs.existsSync(file)) continue;
    try {
      fs.unlinkSync(file);
      deleted = true;
    } catch {
      // ignore
    }
  }
  return deleted;
}

// --- Rewind helpers (SS-2, pure and unit-tested) ---

export type RewindScope = "both" | "code" | "conversation";

/** Resolve /rewind target: 1-based turn index, "last", or checkpoint id. */
export function resolveRewindTarget(
  turns: TurnSnapshot[] | undefined,
  selector: string,
): TurnSnapshot | null {
  const list = turns ?? [];
  if (list.length === 0) return null;
  const s = selector.trim().toLowerCase();
  if (!s || s === "last" || s === "latest") return list[list.length - 1];
  const num = Number(s);
  if (Number.isInteger(num) && num >= 1 && num <= list.length) {
    return list[num - 1];
  }
  const byCheckpoint = list.find((t) => t.checkpointId === selector.trim());
  if (byCheckpoint) return byCheckpoint;
  return null;
}

/** Conversation half of a rewind: drop everything the target turn (and later) added. */
export function truncateHistoryForRewind(history: unknown[], target: TurnSnapshot): unknown[] {
  const start = Math.max(0, Math.min(target.historyStart, history.length));
  return history.slice(0, start);
}

/** Drop turns at/after the target index; keep earlier snapshots. */
export function dropTurnsFrom(turns: TurnSnapshot[], targetIndex: number): TurnSnapshot[] {
  return turns.filter((t) => t.index < targetIndex);
}

// --- Titles + export (SS-4) ---

/** Deterministic fallback title when the fast model is unavailable. */
export function deriveTitle(task: string): string {
  const firstLine = task.split("\n")[0].trim().replace(/\s+/g, " ");
  if (!firstLine) return "New session";
  return firstLine.slice(0, 60);
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function historyToMarkdown(history: unknown[]): string {
  const lines: string[] = [];
  for (const item of history) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    if ((r.role === "user" || r.role === "assistant") && typeof r.content === "string" && r.content.trim()) {
      lines.push(`### ${r.role === "user" ? "User" : "Assistant"}\n\n${r.content.trim()}\n`);
    } else if (r.type === "message" && typeof r.content === "string" && r.content.trim()) {
      lines.push(`### Assistant\n\n${r.content.trim()}\n`);
    } else if (r.type === "function_call") {
      lines.push(`- tool \`${String(r.name ?? "unknown")}\` called`);
    } else if (r.type === "function_call_output") {
      const out = String(r.output ?? "").slice(0, 500);
      if (out.trim()) lines.push(`  - output: ${out.trim().split("\n")[0]}`);
    }
  }
  return lines.join("\n");
}

/** Render a session as Markdown for /export (SS-4). Pure; caller writes the file. */
export function exportSessionMarkdown(record: SessionRecord): string {
  const head = [
    `# ${record.title || "CodeAgent session"}`,
    "",
    `- session: \`${record.id}\``,
    `- repo: \`${record.repoRoot}\``,
    `- created: ${record.createdAt}`,
    `- updated: ${record.updatedAt}`,
    `- turns: ${record.turnCount}`,
    record.model ? `- model: \`${record.model}\`` : null,
    record.modifiedFiles.length > 0 ? `- files: ${record.modifiedFiles.map((f) => `\`${f}\``).join(", ")}` : null,
    "",
  ].filter((l): l is string => l !== null);
  const turns = (record.turns ?? []).map(
    (t) => `- turn ${t.index} (${t.timestamp}): ${t.label.slice(0, 80)}${t.checkpointId ? ` [checkpoint ${t.checkpointId}]` : ""}`,
  );
  const body = historyToMarkdown(record.history ?? []);
  return [
    ...head,
    turns.length > 0 ? `## Turns\n\n${turns.join("\n")}\n` : "",
    body ? `## Conversation\n\n${body}` : "_No conversation recorded._\n",
  ].join("\n");
}

/** Replace history wholesale (e.g. after compaction rewrote it). Crash-safe single line. */
export function rewriteSessionHistory(
  record: SessionRecord,
  history: unknown[],
  home: string = os.homedir(),
): void {
  ensureJsonlExists(record, home);
  record.history = [...history];
  record.updatedAt = new Date().toISOString();
  const release = acquireSessionLock(record.id, home);
  try {
    const line: JsonlRewriteLine = {
      v: 1,
      kind: "rewrite",
      updatedAt: record.updatedAt,
      history: record.history,
      turnCount: record.turnCount,
    };
    fs.appendFileSync(sessionJsonlPath(record.id, home), JSON.stringify(line) + "\n", "utf8");
    fsyncFile(sessionJsonlPath(record.id, home));
    writeJsonCrashSafe(sessionJsonPath(record.id, home), record);
  } catch {
    // Best-effort.
  } finally {
    release();
  }
}

/** Suggested shell-safe export filename for a session. */
export function defaultExportFilename(record: SessionRecord): string {
  const slug = (record.title || "session")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "session";
  return `${record.id}-${slug}.md`;
}

export { shellQuote };
