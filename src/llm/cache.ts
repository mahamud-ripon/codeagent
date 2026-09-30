/**
 * ML-9 prompt caching: Anthropic cache-control breakpoints + stable prefix order
 * (system → tools → memory → history). Pure helpers, unit-tested.
 */

export interface CacheableMessage {
  role: string;
  content: unknown;
}

export function orderPrefixParts(parts: { system?: string; tools?: unknown; memory?: string; history: unknown[] }): unknown[] {
  // Stable order guarantees cache hits across turns.
  const out: unknown[] = [];
  if (parts.system) out.push({ role: "system", content: parts.system });
  if (parts.tools !== undefined) out.push({ role: "system", content: "__tools__", tools: parts.tools });
  if (parts.memory) out.push({ role: "system", content: parts.memory });
  out.push(...parts.history);
  return out;
}

interface AnthropicBlock { type: string; text?: string; cache_control?: { type: string } }

/** Attach cache_control to the last N system-ish blocks (Anthropic allows ≤4 breakpoints). */
export function withAnthropicCacheBreakpoints(
  systemBlocks: Array<{ text: string }>,
  maxBreakpoints = 2,
): AnthropicBlock[] {
  const blocks: AnthropicBlock[] = systemBlocks.map((b) => ({ type: "text", text: b.text }));
  const n = Math.min(maxBreakpoints, 4, blocks.length);
  for (let i = 0; i < n; i++) {
    const idx = blocks.length - 1 - i;
    blocks[idx] = { ...blocks[idx]!, cache_control: { type: "ephemeral" } };
  }
  return blocks;
}

export function supportsPromptCaching(model: string | undefined): boolean {
  if (!model) return false;
  return /claude|gpt-4o|gpt-4\.1|gpt-5|gemini/i.test(model);
}
