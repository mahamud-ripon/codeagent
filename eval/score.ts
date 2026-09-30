/**
 * QA-1 live scoring (EVAL_LIVE=1): pass rate, turns, tokens, cost, time.
 * The smoke runner validates schemas offline; this module scores live runs
 * and writes eval/results/live.json + a human-readable summary.
 */
import fs from "node:fs/promises";
import path from "node:path";

export interface LiveTaskResult {
  taskId: string;
  ok: boolean;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  seconds: number;
}

export interface LiveSummary {
  total: number;
  passed: number;
  passRate: number;
  medianTurns: number;
  totalCostUsd: number;
  meanSeconds: number;
  results: LiveTaskResult[];
}

export function summarizeLive(results: LiveTaskResult[]): LiveSummary {
  const total = results.length;
  const passed = results.filter((r) => r.ok).length;
  const turns = [...results.map((r) => r.turns)].sort((a, b) => a - b);
  const medianTurns = turns.length ? turns[Math.floor(turns.length / 2)]! : 0;
  return {
    total,
    passed,
    passRate: total ? passed / total : 0,
    medianTurns,
    totalCostUsd: results.reduce((s, r) => s + r.costUsd, 0),
    meanSeconds: total ? results.reduce((s, r) => s + r.seconds, 0) / total : 0,
    results,
  };
}

export async function writeLiveResults(repoRoot: string, summary: LiveSummary): Promise<string> {
  const dir = path.join(repoRoot, "eval", "results");
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, "live.json");
  await fs.writeFile(file, JSON.stringify({ ...summary, at: new Date().toISOString() }, null, 2));
  return file;
}

export function renderLiveSummary(summary: LiveSummary): string {
  return [
    `eval live: ${summary.passed}/${summary.total} passed (${(summary.passRate * 100).toFixed(1)}%)`,
    `median turns: ${summary.medianTurns} · cost: $${summary.totalCostUsd.toFixed(4)} · mean: ${summary.meanSeconds.toFixed(1)}s`,
  ].join("\n");
}
