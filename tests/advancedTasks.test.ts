import { describe, expect, it } from "vitest";
import tasks from "../eval/tasks.json";
import advanced from "../eval/tasks-advanced.json";

interface EvalTask {
  id: string;
  bucket: string;
  language: string;
  prompt: string;
  files: Record<string, string>;
  expect: string;
  verify?: { file: string; content: string; run: string; expectOut?: string };
  timeoutSec?: number;
  maxIterations?: number;
}

const BUCKETS = new Set(["bugfix", "feature", "refactor", "tests", "rename"]);
const LANGUAGES = new Set(["ts", "py", "go"]);

function checkSchema(list: EvalTask[], opts: { advanced: boolean }): void {
  const ids = new Set<string>();
  for (const t of list) {
    expect(t.id, "task id").toMatch(/^[a-z0-9-]+$/);
    expect(ids.has(t.id), `duplicate id ${t.id}`).toBe(false);
    ids.add(t.id);
    expect(BUCKETS.has(t.bucket), `${t.id} bucket`).toBe(true);
    expect(LANGUAGES.has(t.language), `${t.id} language`).toBe(true);
    expect(t.prompt.trim().length, `${t.id} prompt`).toBeGreaterThan(0);
    expect(Object.keys(t.files).length, `${t.id} files`).toBeGreaterThan(0);
    expect(t.expect.trim().length, `${t.id} expect`).toBeGreaterThan(0);
    if (opts.advanced) {
      expect(t.verify, `${t.id} verify (advanced suite requires it)`).toBeDefined();
      expect(t.verify!.file.trim().length, `${t.id} verify.file`).toBeGreaterThan(0);
      expect(t.verify!.content.trim().length, `${t.id} verify.content`).toBeGreaterThan(0);
      expect(t.verify!.run.trim().length, `${t.id} verify.run`).toBeGreaterThan(0);
      expect(Object.keys(t.files), `${t.id} verify file must not collide`).not.toContain(t.verify!.file);
      if (t.timeoutSec !== undefined) expect(t.timeoutSec, `${t.id} timeoutSec`).toBeGreaterThan(0);
      if (t.maxIterations !== undefined) expect(t.maxIterations, `${t.id} maxIterations`).toBeGreaterThan(0);
    }
  }
}

describe("eval task schemas", () => {
  it("base suite validates", () => {
    checkSchema(tasks as EvalTask[], { advanced: false });
    expect((tasks as EvalTask[]).length).toBeGreaterThanOrEqual(30);
  });

  it("advanced suite validates (20 hard tasks, all verified)", () => {
    checkSchema(advanced as EvalTask[], { advanced: true });
    expect((advanced as EvalTask[]).length).toBe(20);
  });

  it("ids are unique across both suites", () => {
    const ids = [...(tasks as EvalTask[]), ...(advanced as EvalTask[])].map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("advanced expect alternatives are absent from the initial files", () => {
    // An expect alternative already present initially would pass without
    // any agent action (the verify step is the real gate, but expects
    // should still be discriminating where expressible).
    const weak: string[] = [];
    for (const t of advanced as EvalTask[]) {
      const blob = Object.values(t.files).join("\n");
      const alts = t.expect.includes("|")
        ? t.expect.split("|").map((p) => p.trim()).filter(Boolean)
        : [t.expect.trim()];
      if (alts.every((a) => blob.includes(a))) weak.push(t.id);
    }
    // Anchor-style expects (verified by the hidden check) are allowed, but
    // the list must stay short and deliberate.
    expect(weak.sort()).toEqual(["adv-ts-config-merge", "adv-ts-import-cycle"]);
  });
});
