import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createSession,
  deleteSession,
  formatTimeAgo,
  listSessions,
  loadSession,
  saveSession,
} from "../src/session/sessionManager.js";

describe("sessionManager", () => {
  let tmpHome: string;
  const repo1 = "D:/projects/RepoA";
  const repo2 = "D:/projects/RepoB";

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "codeagent-test-home-"));
  });

  afterEach(async () => {
    await fs.rm(tmpHome, { recursive: true, force: true });
  });

  it("creates, saves, and loads a session record", () => {
    const session = createSession(repo1, {
      title: "Test session",
      model: "test-model",
      history: [{ role: "user", content: "hello" }],
    });

    expect(session.id).toMatch(/^ses_\d+_\d+_[a-z0-9]+/);
    expect(session.title).toBe("Test session");

    const filePath = saveSession(session, tmpHome);
    expect(filePath).toContain(session.id);

    const loaded = loadSession(session.id, tmpHome);
    expect(loaded).not.toBeNull();
    expect(loaded?.id).toBe(session.id);
    expect(loaded?.title).toBe("Test session");
    expect(loaded?.model).toBe("test-model");
    expect(loaded?.history).toHaveLength(1);
  });

  it("lists sessions and filters by repoRoot", () => {
    const s1 = createSession(repo1, { title: "Repo 1 - Session 1" });
    const s2 = createSession(repo1, { title: "Repo 1 - Session 2" });
    const s3 = createSession(repo2, { title: "Repo 2 - Session 1" });

    saveSession(s1, tmpHome);
    saveSession(s2, tmpHome);
    saveSession(s3, tmpHome);

    // List all
    const all = listSessions(undefined, tmpHome);
    expect(all).toHaveLength(3);

    // Filter by repo1
    const repo1Sessions = listSessions(repo1, tmpHome);
    expect(repo1Sessions).toHaveLength(2);
    expect(repo1Sessions.map((s) => s.title)).toContain("Repo 1 - Session 1");
    expect(repo1Sessions.map((s) => s.title)).toContain("Repo 1 - Session 2");

    // Filter by repo2
    const repo2Sessions = listSessions(repo2, tmpHome);
    expect(repo2Sessions).toHaveLength(1);
    expect(repo2Sessions[0].title).toBe("Repo 2 - Session 1");
  });

  it("deletes a session file cleanly", () => {
    const session = createSession(repo1, { title: "To be deleted" });
    saveSession(session, tmpHome);

    expect(loadSession(session.id, tmpHome)).not.toBeNull();
    const deleted = deleteSession(session.id, tmpHome);
    expect(deleted).toBe(true);
    expect(loadSession(session.id, tmpHome)).toBeNull();

    // Deleting nonexistent returns false
    expect(deleteSession("nonexistent-id", tmpHome)).toBe(false);
  });

  it("formats relative times cleanly", () => {
    const now = new Date().toISOString();
    expect(formatTimeAgo(now)).toBe("just now");

    const fiveMinsAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    expect(formatTimeAgo(fiveMinsAgo)).toBe("5m ago");

    const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
    expect(formatTimeAgo(twoHoursAgo)).toBe("2h ago");
  });
});
