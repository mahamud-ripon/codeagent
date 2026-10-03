/** Paired release evaluation. No network or scores are fabricated when configuration is absent. */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadGlobalEnv } from "../src/cli/config.js";
const exec = promisify(execFile);
loadGlobalEnv();
const args = process.argv.slice(2);
const option = (n: string) => args[args.indexOf(n) + 1];
const manifest = JSON.parse(
  await fs.readFile("eval/release-manifest.json", "utf8"),
);
for (const [file, hash] of Object.entries(manifest.suites)) {
  if (
    createHash("sha256")
      .update(await fs.readFile(file))
      .digest("hex") !== hash
  )
    throw new Error(`Frozen suite changed: ${file}`);
}
const tasks = (
  await Promise.all(
    Object.keys(manifest.suites).map(async (f) =>
      JSON.parse(await fs.readFile(f, "utf8")),
    ),
  )
).flat();
const identities = new Set(
  tasks.flatMap((t: any) => [1, 2, 3].map((seed) => `${t.id}:${seed}`)),
);
if (tasks.length !== 50 || identities.size !== 150)
  throw new Error("Expected 50 distinct frozen tasks");
if (args.includes("--check")) {
  console.log(
    "Release fixture hashes verified (20 advanced + 30 held-out tasks, 3 repetitions).",
  );
  process.exit(0);
}
if (args.includes("--compare")) {
  const before = JSON.parse(await fs.readFile(option("--baseline"), "utf8")),
    after = JSON.parse(await fs.readFile(option("--candidate"), "utf8"));
  if (
    JSON.stringify(before.configuration) !== JSON.stringify(after.configuration)
  )
    throw new Error("Models, suites, settings and budgets must match");
  if (
    JSON.stringify(before.configuration.suites) !==
      JSON.stringify(manifest.suites) ||
    before.configuration.calls !== manifest.modelCalls ||
    before.configuration.timeoutSeconds !== manifest.wallTimeSeconds ||
    before.configuration.seeds !== manifest.repetitions
  )
    throw new Error("Results do not use the frozen release suites and budgets");
  if (before.rows.length !== 150 || after.rows.length !== 150)
    throw new Error("Both engines need all 50 tasks × 3 repetitions");
  const valid = (r: any[]) =>
    new Set(r.map((x) => `${x.task}:${x.seed}`)).size === 150 &&
    r.every(
      (x) =>
        identities.has(`${x.task}:${x.seed}`) &&
        typeof x.passed === "boolean" &&
        typeof x.claimedComplete === "boolean" &&
        Number.isFinite(x.latencyMs) &&
        x.latencyMs >= 0,
    );
  if (!valid(before.rows) || !valid(after.rows))
    throw new Error("Invalid or duplicate task results");
  const completed = (x: any) => x.passed && x.claimedComplete;
  const passed = (r: any[]) => r.filter(completed).length,
    falseComplete = (r: any[]) =>
      r.filter((x) => x.claimedComplete && !x.passed).length;
  const improvement = ((passed(after.rows) - passed(before.rows)) / 150) * 100;
  // Paired cluster bootstrap: resample task identities, keeping repetitions together.
  let rng = 1729;
  const random = () => {
    rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0;
    return rng / 2 ** 32;
  };
  const differences = tasks.map(
    (t: any) =>
      (after.rows.filter((r: any) => r.task === t.id && completed(r)).length -
        before.rows.filter((r: any) => r.task === t.id && completed(r))
          .length) /
      3,
  );
  const samples = Array.from(
    { length: 10000 },
    () =>
      (differences.reduce(
        (sum: number) =>
          sum + differences[Math.floor(random() * differences.length)],
        0,
      ) /
        differences.length) *
      100,
  ).sort((a, b) => a - b);
  const metrics = (rows: any[]) => ({
    completionRate: passed(rows) / rows.length,
    falseCompletionRate: falseComplete(rows) / rows.length,
    meanLatencyMs: rows.reduce((s, r) => s + r.latencyMs, 0) / rows.length,
    inputTokens: rows.reduce((s, r) => s + (r.usage?.input ?? 0), 0),
    outputTokens: rows.reduce((s, r) => s + (r.usage?.output ?? 0), 0),
    knownCostUsd: rows
      .filter((r) => r.costKnown)
      .reduce((s, r) => s + (r.usage?.costUsd ?? 0), 0),
    unknownCostRuns: rows.filter((r) => !r.costKnown).length,
    failures: rows
      .filter((r) => !completed(r))
      .map((r) => ({
        task: r.task,
        repetition: r.seed,
        error: r.error,
        status: r.status,
      })),
  });
  console.log(
    JSON.stringify(
      {
        baseline: metrics(before.rows),
        candidate: metrics(after.rows),
        improvement95PercentInterval: [samples[250], samples[9749]],
        before: passed(before.rows),
        after: passed(after.rows),
        improvementPercentagePoints: improvement,
        falseCompletionBefore: falseComplete(before.rows),
        falseCompletionAfter: falseComplete(after.rows),
        qualityGate:
          improvement >= 10 &&
          falseComplete(after.rows) <= falseComplete(before.rows),
        note: "150 runs cover 50 task identities; repetitions are correlated. Reliability CI gates must also pass.",
      },
      null,
      2,
    ),
  );
  process.exit(
    improvement >= 10 && falseComplete(after.rows) <= falseComplete(before.rows)
      ? 0
      : 1,
  );
}
if (
  !process.env.MODEL ||
  ![
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "GEMINI_API_KEY",
    "OPENAI_BASE_URL",
  ].some((k) => process.env[k])
) {
  console.error(
    "Release evaluation blocked: configure MODEL and a real model provider. Emulators do not measure coding quality.",
  );
  process.exit(2);
}
if (!args.includes("--engine") || !args.includes("--output"))
  throw new Error("Use --engine <src/agent/agent.ts> --output <file>");
const { Agent } = await import(
  pathToFileURL(path.resolve(option("--engine"))).href
);
const rows: any[] = [];
const configuration = {
  model: process.env.MODEL,
  provider: process.env.LLM_PROVIDER ?? "auto",
  endpointHash: createHash("sha256")
    .update(process.env.OPENAI_BASE_URL ?? "default")
    .digest("hex"),
  settings: { autoApprove: true, memoryEnabled: false },
  suites: manifest.suites,
  calls: 30,
  timeoutSeconds: 600,
  seeds: 3,
};
for (let seed = 1; seed <= 3; seed++)
  for (const task of tasks) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codeagent-release-"));
    const contextHome = await fs.mkdtemp(
      path.join(os.tmpdir(), "codeagent-release-home-"),
    );
    const started = Date.now();
    let result: any;
    let passed = false;
    let error: string | undefined;
    try {
      for (const [name, content] of Object.entries(task.files)) {
        const file = path.join(dir, name);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, String(content));
      }
      result = await new Agent({
        repoRoot: dir,
        model: process.env.MODEL,
        maxIterations: 30,
        autoApprove: true,
        verbose: false,
        memoryEnabled: false,
        contextHome,
      }).run(task.prompt, { signal: AbortSignal.timeout(600000) });
      const check = task.verify;
      if (check) {
        await fs.writeFile(path.join(dir, check.file), check.content);
        const r = await exec(
          process.platform === "win32" ? "cmd.exe" : "sh",
          process.platform === "win32" ? ["/c", check.run] : ["-c", check.run],
          { cwd: dir, timeout: 120000 },
        );
        passed = !check.expectOut || r.stdout.includes(check.expectOut);
      }
    } catch (e) {
      error = String(e);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
      await fs.rm(contextHome, { recursive: true, force: true });
    }
    rows.push({
      task: task.id,
      seed,
      passed,
      claimedComplete: result?.stopReason === "ok",
      status: result?.status ?? result?.stopReason,
      finalMessage: result?.finalMessage,
      latencyMs: Date.now() - started,
      usage: result?.usage,
      costKnown: result?.costKnown ?? false,
      error,
    });
    const out = option("--output");
    await fs.mkdir(path.dirname(out), { recursive: true });
    await fs.writeFile(out, JSON.stringify({ configuration, rows }, null, 2));
    console.log(`${task.id} seed ${seed}: ${passed ? "pass" : "fail"}`);
  }
