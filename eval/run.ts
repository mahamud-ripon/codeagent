import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PROMPT_VERSION } from "../src/agent/promptSections.js";

interface Task {
  id: string;
  bucket: string;
  language: string;
  prompt: string;
  files: Record<string, string>;
  expect: string;
}

const root = path.dirname(fileURLToPath(import.meta.url));
const tasks = JSON.parse(fs.readFileSync(path.join(root, "tasks.json"), "utf8")) as Task[];
const buckets = new Set(["bugfix", "feature", "refactor", "tests", "rename"]);
const languages = new Set(["ts", "py", "go"]);
const errors: string[] = [];

if (tasks.length < 30) errors.push(`expected at least 30 tasks, found ${tasks.length}`);
const ids = new Set<string>();
for (const task of tasks) {
  if (ids.has(task.id)) errors.push(`duplicate id ${task.id}`);
  ids.add(task.id);
  if (!buckets.has(task.bucket)) errors.push(`${task.id} has unknown bucket ${task.bucket}`);
  if (!languages.has(task.language)) errors.push(`${task.id} has unknown language ${task.language}`);
  if (!task.prompt.trim()) errors.push(`${task.id} has an empty prompt`);
  if (!task.expect.trim()) errors.push(`${task.id} has an empty expectation`);
}

const outDir = path.join(root, "results");
fs.mkdirSync(outDir, { recursive: true });
const report = {
  mode: "smoke",
  tasks: tasks.length,
  ok: errors.length === 0,
  errors,
  // F-8: pin the prompt version so a prompt change without a fresh live
  // baseline is visible (promptVersion mismatch vs eval/results/live.json).
  promptVersion: PROMPT_VERSION,
  note: "Live model scores need EVAL_LIVE=1 and an API key. This smoke run checks the task set only.",
};
fs.writeFileSync(path.join(outDir, "smoke.json"), JSON.stringify(report, null, 2));
fs.writeFileSync(
  path.join(root, "BASELINE.md"),
  [
    "# Eval baseline",
    "",
    "A live model baseline was not recorded in this environment because no model endpoint was configured.",
    "The smoke runner validates the task set. Run `npm run eval` in CI.",
    "Set `EVAL_LIVE=1` when a provider is available to score the same tasks against a model.",
    "",
    `Smoke: ${tasks.length} tasks, ok=${report.ok}.`,
    `Prompt version: ${PROMPT_VERSION} (compare with eval/results/live.json after a live run; a mismatch means the baseline is stale).`,
    "",
  ].join("\n"),
);

if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log(`eval smoke ok (${tasks.length} tasks)`);
