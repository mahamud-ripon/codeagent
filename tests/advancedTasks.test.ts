import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import tasks from "../eval/tasks.json";
import advanced from "../eval/tasks-advanced.json";
import advancedV1 from "../eval/tasks-advanced-v1.json";
import advancedV2 from "../eval/tasks-advanced-v2.json";
import { canonicalOutcome, isInfraOutcome } from "../eval/score.js";
import { classifyAbort } from "../eval/instrument.js";

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

function byId(list: EvalTask[], id: string): EvalTask {
  const t = (list as EvalTask[]).find((x) => x.id === id);
  if (!t) throw new Error(`missing task ${id}`);
  return t;
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

describe("advanced-v1 frozen", () => {
  it("v1 is byte-for-byte identical to the frozen source", () => {
    const root = path.dirname(fileURLToPath(import.meta.url));
    const v1Bytes = fs.readFileSync(path.join(root, "..", "eval", "tasks-advanced-v1.json"));
    const srcBytes = fs.readFileSync(path.join(root, "..", "eval", "tasks-advanced.json"));
    // tasks-advanced.json is the frozen source; v1 must never drift from it.
    expect(v1Bytes.equals(srcBytes)).toBe(true);
    expect((advancedV1 as EvalTask[]).length).toBe(20);
  });

  it("v1 hash matches BASELINE.md", () => {
    const root = path.dirname(fileURLToPath(import.meta.url));
    const v1Bytes = fs.readFileSync(path.join(root, "..", "eval", "tasks-advanced-v1.json"));
    const hash = createHash("sha256").update(v1Bytes).digest("hex");
    const baseline = fs.readFileSync(path.join(root, "..", "eval", "BASELINE.md"), "utf8");
    expect(baseline).toContain(hash);
    expect(baseline).toContain("advanced-v1");
    expect(baseline).toContain("advanced-v2");
  });
});

describe("advanced-v2 corrections (harness-only)", () => {
  it("v2 validates and keeps 20 tasks", () => {
    checkSchema(advancedV2 as EvalTask[], { advanced: true });
    expect((advancedV2 as EvalTask[]).length).toBe(20);
  });

  it("shared-types regex accepts ./types and ./types.js", () => {
    const t = byId(advancedV2 as EvalTask[], "adv-ts-shared-types");
    expect(t.verify!.content).toContain("types(\\.js)?");
    expect(t.verify!.content).not.toContain("types\\.js?");
    const re = /require\(["']\.\/types(\.js)?["']\)/;
    expect(re.test('require("./types")')).toBe(true);
    expect(re.test("require('./types.js')")).toBe(true);
  });

  it("py-shadow expect is not a hidden name", () => {
    const t = byId(advancedV2 as EvalTask[], "adv-py-shadow");
    expect(t.expect).not.toBe("jsonutil");
    expect(t.expect).toBe("helper");
    expect(t.verify!.content).toContain("SHADOW-OK");
  });

  it("middleware verifier accepts both 4-arg and 3-arg handlers", () => {
    const t = byId(advancedV2 as EvalTask[], "adv-ts-middleware");
    expect(t.prompt).toContain("4-arg");
    expect(t.prompt).toContain("fn(req, res)");
    expect(t.verify!.content).toContain("(err, req, res, next)");
    expect(t.verify!.content).toContain("(err, req, res)");
    expect(t.verify!.content).toContain("MIDDLEWARE-OK");
  });

  it("py-config prompt names the dataclasses the verifier constructs", () => {
    const t = byId(advancedV2 as EvalTask[], "adv-py-config");
    for (const name of ["AppConfig", "DbConfig", "CacheConfig"]) {
      expect(t.prompt).toContain(name);
      expect(t.verify!.content).toContain(name);
    }
  });

  it("go-pool prompt keeps package main and signatures", () => {
    const t = byId(advancedV2 as EvalTask[], "adv-go-pool");
    expect(t.prompt).toContain("package main");
    expect(t.prompt).toContain("Submit");
  });
});

describe("v2 abort taxonomy (aliases + deadline)", () => {
  it("old enum values remain as aliases", () => {
    expect(canonicalOutcome("TASK_PASS")).toBe("PASS");
    expect(canonicalOutcome("TASK_FAIL")).toBe("MODEL_FAILURE");
    expect(canonicalOutcome("MODEL_TIMEOUT")).toBe("TIMEOUT");
    expect(canonicalOutcome("MODEL_RATE_LIMIT")).toBe("RATE_LIMIT");
    expect(canonicalOutcome("PROVIDER_ERROR")).toBe("PROVIDER_FAILURE");
  });

  it("infra classes are TIMEOUT/RATE_LIMIT/PROVIDER_FAILURE", () => {
    expect(isInfraOutcome("TIMEOUT")).toBe(true);
    expect(isInfraOutcome("MODEL_TIMEOUT")).toBe(true);
    expect(isInfraOutcome("RATE_LIMIT")).toBe(true);
    expect(isInfraOutcome("PROVIDER_FAILURE")).toBe(true);
    expect(isInfraOutcome("MODEL_FAILURE")).toBe(false);
    expect(isInfraOutcome("PASS")).toBe(false);
  });

  it("Provider request cancelled at the deadline is TIMEOUT", () => {
    expect(
      classifyAbort({
        message: "Provider request cancelled (AbortSignal).",
        deadlineMs: 600_000,
        elapsedMs: 599_000,
        timedOut: true,
      }),
    ).toBe("TIMEOUT");
  });

  it("agent-written code that does not compile is MODEL_FAILURE even when prose mentions CGO", () => {
    expect(
      classifyAbort({
        message: "Summary: hit a CGO snag earlier, fixed it.\nverify exited 1: declared and not used: val",
        verifyDetail: 'verify "go test" exited 1: declared and not used: val',
        deadlineMs: 600_000,
        elapsedMs: 216_000,
        timedOut: false,
      }),
    ).toBe("MODEL_FAILURE");
  });

  it("a real environment failure in the check output is TOOL_FAILURE", () => {
    expect(
      classifyAbort({
        message: "verify failed",
        verifyDetail: "go test -race failed: CGO compiler missing",
        deadlineMs: 600_000,
        elapsedMs: 100_000,
        timedOut: false,
      }),
    ).toBe("TOOL_FAILURE");
  });

  it("a thrown tool exception without verify output is TOOL_FAILURE", () => {
    expect(
      classifyAbort({
        message: "ripgrep (rg) binary not found",
        fromException: true,
        deadlineMs: 600_000,
        elapsedMs: 5_000,
        timedOut: false,
      }),
    ).toBe("TOOL_FAILURE");
  });
});
