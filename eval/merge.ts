import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { summarizeLive, writeLiveResults, renderLiveSummary, type LiveTaskResult } from "./score.js";

const root = path.dirname(fileURLToPath(import.meta.url));
const resultsDir = path.join(root, "results");

const allResults: LiveTaskResult[] = [];
const seenTasks = new Set<string>();

for (let i = 1; i <= 12; i++) {
  const chunkPath = path.join(resultsDir, `live-fast${i}.json`);
  if (!fs.existsSync(chunkPath)) {
    console.error(`eval:merge: missing chunk ${chunkPath}`);
    continue;
  }
  const data = JSON.parse(fs.readFileSync(chunkPath, "utf8"));
  for (const r of data.results as LiveTaskResult[]) {
    if (!seenTasks.has(r.taskId)) {
      seenTasks.add(r.taskId);
      allResults.push(r);
    }
  }
}

if (allResults.length === 0) {
  console.error("eval:merge: no results found to merge.");
  process.exit(1);
}

const summary = summarizeLive(allResults);
const repoRoot = path.join(root, "..");
const file = await writeLiveResults(repoRoot, summary);
console.log(renderLiveSummary(summary));
console.log(`Merged ${allResults.length} task results into ${file}`);
