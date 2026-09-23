import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
}

export function sessionsDir(home: string = os.homedir()): string {
  return path.join(home, ".codeagent", "sessions");
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
  };
}

export function saveSession(
  record: SessionRecord,
  home: string = os.homedir(),
): string {
  const dir = sessionsDir(home);
  fs.mkdirSync(dir, { recursive: true });
  record.updatedAt = new Date().toISOString();
  const file = path.join(dir, `${record.id}.json`);
  fs.writeFileSync(file, JSON.stringify(record, null, 2), "utf8");
  return file;
}

export function loadSession(
  id: string,
  home: string = os.homedir(),
): SessionRecord | null {
  const dir = sessionsDir(home);
  const file = path.join(dir, `${id}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    const raw = fs.readFileSync(file, "utf8");
    return JSON.parse(raw) as SessionRecord;
  } catch {
    return null;
  }
}

export function listSessions(
  repoRoot?: string,
  home: string = os.homedir(),
): SessionRecord[] {
  const dir = sessionsDir(home);
  if (!fs.existsSync(dir)) return [];
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }

  const sessions: SessionRecord[] = [];
  for (const f of files) {
    try {
      const raw = fs.readFileSync(path.join(dir, f), "utf8");
      const record = JSON.parse(raw) as SessionRecord;
      if (record && typeof record.id === "string") {
        if (!repoRoot || path.resolve(record.repoRoot) === path.resolve(repoRoot)) {
          sessions.push(record);
        }
      }
    } catch {
      // ignore unreadable/corrupted files
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
  const file = path.join(dir, `${id}.json`);
  if (!fs.existsSync(file)) return false;
  try {
    fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}
