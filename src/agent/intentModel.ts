import { classifyIntent, type AgentIntent } from "./intent.js";
import type { Responder } from "../llm/client.js";

/**
 * AG-2 remainder: replace the regex bypass with a prompt rule plus an
 * optional fast-model check. Regex stays the synchronous default; when a
 * fast responder is available, ambiguous prompts get a second opinion.
 * Never throws: failures fall back to the regex verdict.
 */
export function isAmbiguousForIntent(prompt: string): boolean {
  const words = prompt.trim().split(/\s+/).filter(Boolean).length;
  return words >= 4 && words <= 14 && !/(fix|add|create|implement|test|refactor|delete|remove)/i.test(prompt);
}

export async function classifyIntentWithModel(prompt: string, fast?: Responder): Promise<AgentIntent> {
  const base = classifyIntent(prompt);
  // Deterministic routing already decided non-task: trust it without
  // spending a fast-model roundtrip (fixes 40s+ deliberation on trivia).
  // Only ambiguous task-shaped prompts get a second opinion.
  if (!fast || !isAmbiguousForIntent(prompt)) return base;
  // If regex already said conversational/external, don't override to task
  // via model — cheap routing wins for trivial intent.
  if (base === "conversational" || base === "external") return base;
  try {
    const res = await fast([
      { role: "system", content: "Classify the user request as one word: conversational, inquiry, external, or task. Reply with only that word." },
      { role: "user", content: prompt },
    ], { tools: false });
    const word = (res.output_text ?? "").trim().toLowerCase();
    if (word.includes("conversational")) return "conversational";
    if (word.includes("external")) return "external";
    if (word.includes("inquiry")) return "inquiry";
    if (word.includes("task")) return "task";
    return base;
  } catch {
    return base;
  }
}
