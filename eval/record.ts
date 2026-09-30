/**
 * QA-4 live-recorded fixtures: capture a real provider stream to
 * eval/fixtures/<name>.jsonl for contract replay.
 * Usage: EVAL_LIVE=1 npm run eval:record -- <name>
 * Without an endpoint it exits 2 (synthetic replay in tests/providerContract.test.ts stays the gate).
 *
 * The fixture starts with a {meta} line (provider, model, prompt version,
 * recorded-at), followed by one JSON object per ProviderEvent, so the
 * contract tests can replay real shapes including 429/Retry-After and
 * truncated-frame handling.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createProviderFromEnv, MissingApiKeyError } from "../src/llm/provider.js";
import { PROMPT_VERSION } from "../src/agent/promptSections.js";
import type { ProviderEvent } from "../src/llm/events.js";
import { loadGlobalEnv } from "../src/cli/config.js";

loadGlobalEnv();

const root = path.dirname(fileURLToPath(import.meta.url));
const name = (process.argv[2] ?? "stream").replace(/[^a-z0-9_-]+/gi, "-").slice(0, 40) || "stream";
if (process.env.EVAL_LIVE !== "1") {
  console.log("eval:record needs EVAL_LIVE=1 and a model endpoint. Synthetic replay covers CI.");
  process.exit(2);
}
const hasKey = !!process.env.OPENAI_API_KEY || !!process.env.ANTHROPIC_API_KEY || !!process.env.GEMINI_API_KEY;
if (!hasKey && !process.env.OPENAI_BASE_URL) {
  console.error("eval:record: no model endpoint configured (set OPENAI_API_KEY or OPENAI_BASE_URL + MODEL).");
  process.exit(2);
}

const dir = path.join(root, "fixtures");
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, `${name}.jsonl`);

const { info, providerInstance, responder, systemPrompt } = (() => {
  try {
    return createProviderFromEnv(process.env);
  } catch (e) {
    if (e instanceof MissingApiKeyError) {
      console.error(`eval:record: ${e.message}`);
      process.exit(2);
    }
    throw e;
  }
})();

const events: ProviderEvent[] = [];
try {
  if (providerInstance) {
    for await (const e of providerInstance.stream({
      system: systemPrompt,
      messages: [{ role: "user", content: "Reply with exactly: OK" }],
      tools: false,
    })) {
      events.push(e);
    }
  } else {
    // Offline-responder fallback path: record the collapsed result.
    const res = await responder([{ role: "user", content: "Reply with exactly: OK" }], { tools: false });
    if (res.output_text) events.push({ type: "text_delta", text: res.output_text });
    if (res.usage) events.push({ type: "usage", input: res.usage.input ?? 0, output: res.usage.output ?? 0 });
    events.push({ type: "stop", finishReason: res.finish_reason ?? "stop" });
  }
} catch (e) {
  if (e instanceof MissingApiKeyError) {
    console.error(`eval:record: ${e.message}`);
    process.exit(2);
  }
  throw e;
}

const lines = [
  JSON.stringify({ meta: true, provider: info.kind, model: info.model, promptVersion: PROMPT_VERSION, at: new Date().toISOString() }),
  ...events.map((e) => JSON.stringify(e)),
];
fs.writeFileSync(file, `${lines.join("\n")}\n`);
console.log(`eval record wrote ${file} (${events.length} events, ${info.kind}/${info.model})`);
