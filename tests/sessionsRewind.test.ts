import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  appendSessionTurn,
  createSession,
  defaultExportFilename,
  deleteSession,
  deriveTitle,
  dropTurnsFrom,
  exportSessionMarkdown,
  listSessions,
  loadSession,
  resolveRewindTarget,
  rewriteSessionHistory,
  saveSession,
  truncateHistoryForRewind,
  type TurnSnapshot,
} from "../src/session/sessionManager.js";
import { doRewind } from "../src/cli/repl.js";

function tmpHome(): Promise<string> {
  return fs.promises.mkdtemp(path.join(os.tmpdir(), "codeagent-ss-"));
}

describe("SS-3 JSONL sessions", () => {
  let home = "";
  beforeEach(async () => {
    home = await tmpHome();
  });
  afterEach(async () => {
    await fs.promises.rm(home, { recursive: true, force: true });
  });

  it("appends turns and replays them on load", () => {
    const rec = createSession("/repo", { title: "t" });
    saveSession(rec, home);
    appendSessionTurn(
      rec,
      { label: "first task", historyAppend: [{ role: "user", content: "hi" }], historyStart: 0 },
      home,
    );
    appendSessionTurn(
      rec,
      {
        label: "second",
        historyAppend: [{ role: "assistant", content: "hello" }],
        historyStart: 1,
        checkpoint: { id: "cp-1", timestamp: 1, label: "second", commitHash: "abc" },
      },
      home,
    );
    expect(rec.turnCount).toBe(2);
    expect(rec.turns).toHaveLength(2);

    const loaded = loadSession(rec.id, home)!;
    expect(loaded).not.toBeNull();
    expect(loaded.history).toHaveLength(2);
    expect(loaded.turnCount).toBe(2);
    expect(loaded.turns).toHaveLength(2);
    expect(loaded.checkpoints).toHaveLength(1);
    // JSONL log exists alongside the compat JSON.
    expect(fs.existsSync(path.join(home, ".codeagent", "sessions", `${rec.id}.jsonl`))).toBe(true);
  });

  it("migrates legacy JSON sessions to JSONL on load", () => {
    const rec = createSession("/repo", { title: "legacy", history: [{ role: "user", content: "x" }] });
    const dir = path.join(home, ".codeagent", "sessions");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${rec.id}.json`), JSON.stringify(rec), "utf8");
    expect(fs.existsSync(path.join(dir, `${rec.id}.jsonl`))).toBe(false);
    const loaded = loadSession(rec.id, home)!;
    expect(loaded.history).toHaveLength(1);
    expect(fs.existsSync(path.join(dir, `${rec.id}.jsonl`))).toBe(true);
  });

  it("tolerates a torn last line from a crash", () => {
    const rec = createSession("/repo", { title: "torn" });
    saveSession(rec, home);
    appendSessionTurn(rec, { label: "a", historyAppend: [{ a: 1 }], historyStart: 0 }, home);
    const jsonl = path.join(home, ".codeagent", "sessions", `${rec.id}.jsonl`);
    fs.appendFileSync(jsonl, '{"v":1,"kind":"turn","index":', "utf8");
    const loaded = loadSession(rec.id, home)!;
    expect(loaded.history).toHaveLength(1);
    expect(loaded.turnCount).toBe(1);
  });

  it("rewrite replaces history (compaction case)", () => {
    const rec = createSession("/repo", { history: [{ a: 1 }, { a: 2 }, { a: 3 }] });
    saveSession(rec, home);
    rewriteSessionHistory(rec, [{ compacted: true }], home);
    const loaded = loadSession(rec.id, home)!;
    expect(loaded.history).toEqual([{ compacted: true }]);
  });

  it("lists and deletes both JSON and JSONL files", () => {
    const rec = createSession("/repo", { title: "del" });
    saveSession(rec, home);
    expect(listSessions("/repo", home)).toHaveLength(1);
    expect(deleteSession(rec.id, home)).toBe(true);
    expect(loadSession(rec.id, home)).toBeNull();
  });
});

describe("SS-2 rewind helpers", () => {
  const turns: TurnSnapshot[] = [
    { index: 1, timestamp: "t1", label: "one", historyStart: 0, historyLength: 2, checkpointId: "cp-1" },
    { index: 2, timestamp: "t2", label: "two", historyStart: 2, historyLength: 4, checkpointId: "cp-2" },
  ];

  it("resolves by number, last, and checkpoint id", () => {
    expect(resolveRewindTarget(turns, "1")?.index).toBe(1);
    expect(resolveRewindTarget(turns, "last")?.index).toBe(2);
    expect(resolveRewindTarget(turns, "cp-1")?.index).toBe(1);
    expect(resolveRewindTarget(turns, "nope")).toBeNull();
    expect(resolveRewindTarget([], "1")).toBeNull();
  });

  it("truncates history to the target turn start and drops later turns", () => {
    const history = [{ a: 1 }, { a: 2 }, { a: 3 }, { a: 4 }];
    expect(truncateHistoryForRewind(history, turns[1])).toHaveLength(2);
    expect(dropTurnsFrom(turns, 2)).toHaveLength(1);
  });

  it("doRewind conversation scope truncates and persists without git", async () => {
    const home = await tmpHome();
    try {
      const rec = createSession("/repo", { title: "rw" });
      saveSession(rec, home);
      appendSessionTurn(rec, { label: "one", historyAppend: [{ a: 1 }, { a: 2 }], historyStart: 0 }, home);
      appendSessionTurn(
        rec,
        {
          label: "two",
          historyAppend: [{ a: 3 }, { a: 4 }],
          historyStart: 2,
          checkpoint: { id: "cp-2", timestamp: 2, label: "two", commitHash: "h" },
        },
        home,
      );
      const session = { repoRoot: "/repo", maxIterations: 5, history: rec.history, activeSession: rec, sessionHome: home };
      const res = await doRewind(session as never, "1", "conversation");
      expect(res.ok).toBe(true);
      expect(session.history).toHaveLength(0);
      expect(rec.turns).toHaveLength(0);
      expect(rec.turnCount).toBe(0);
      const loaded = loadSession(rec.id, home)!;
      expect(loaded.history).toHaveLength(0);
      expect(loaded.turns).toHaveLength(0);
    } finally {
      await fs.promises.rm(home, { recursive: true, force: true });
    }
  });

  it("doRewind fails closed with no turns", async () => {
    const rec = createSession("/repo");
    const res = await doRewind(
      { repoRoot: "/repo", maxIterations: 5, history: [], activeSession: rec } as never,
      "1",
      "conversation",
    );
    expect(res.ok).toBe(false);
  });
});

describe("SS-4 titles + export", () => {
  it("derives a deterministic fallback title", () => {
    expect(deriveTitle("")).toBe("New session");
    expect(deriveTitle("Fix the login bug\nmore detail")).toBe("Fix the login bug");
    expect(deriveTitle("x".repeat(100))).toHaveLength(60);
  });

  it("renders markdown with turns and conversation", () => {
    const rec = createSession("/repo", {
      title: "Demo",
      model: "m",
      turnCount: 1,
      history: [
        { role: "user", content: "do it" },
        { type: "message", content: "done" },
      ],
      modifiedFiles: ["src/a.ts"],
      turns: [{ index: 1, timestamp: "t", label: "do it", historyStart: 0, historyLength: 2 }],
    });
    const md = exportSessionMarkdown(rec);
    expect(md).toContain("# Demo");
    expect(md).toContain("do it");
    expect(md).toContain("src/a.ts");
    expect(defaultExportFilename(rec)).toMatch(/\.md$/);
  });
});
