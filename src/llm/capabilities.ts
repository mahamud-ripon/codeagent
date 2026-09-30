export interface ModelCapabilities {
  contextWindow: number;
  maxOutput: number;
  tools: boolean;
  reasoning: boolean;
  caching: boolean;
  /** USD per million input tokens. Absent when the price is unknown. */
  inputPricePerMtok?: number;
  outputPricePerMtok?: number;
}

/** Conservative defaults for models not in the registry. */
export const CONSERVATIVE_CAPABILITIES: ModelCapabilities = {
  contextWindow: 8_192,
  maxOutput: 2_048,
  tools: true,
  reasoning: false,
  caching: false,
};

const REGISTRY: Array<{ match: RegExp; caps: ModelCapabilities }> = [
  {
    match: /claude-opus|claude-sonnet-4|claude-3-5-sonnet|claude-3-7/i,
    caps: {
      contextWindow: 200_000,
      maxOutput: 16_384,
      tools: true,
      reasoning: true,
      caching: true,
      inputPricePerMtok: 3,
      outputPricePerMtok: 15,
    },
  },
  {
    match: /claude-haiku/i,
    caps: {
      contextWindow: 200_000,
      maxOutput: 8_192,
      tools: true,
      reasoning: false,
      caching: true,
      inputPricePerMtok: 0.8,
      outputPricePerMtok: 4,
    },
  },
  {
    match: /gpt-4o|gpt-4\.1|gpt-5/i,
    caps: {
      contextWindow: 128_000,
      maxOutput: 16_384,
      tools: true,
      reasoning: true,
      caching: true,
      inputPricePerMtok: 2.5,
      outputPricePerMtok: 10,
    },
  },
  {
    match: /gemini/i,
    caps: {
      contextWindow: 1_000_000,
      maxOutput: 8_192,
      tools: true,
      reasoning: false,
      caching: false,
      inputPricePerMtok: 0.15,
      outputPricePerMtok: 0.6,
    },
  },
  {
    match: /ollama|llama|qwen|gpt-oss/i,
    caps: {
      contextWindow: 32_768,
      maxOutput: 4_096,
      tools: true,
      reasoning: false,
      caching: false,
    },
  },
];

export function getModelCapabilities(
  model: string | undefined,
  overrides?: { contextWindow?: number; maxOutput?: number },
): ModelCapabilities {
  const id = model?.trim() ?? "";
  const base = !id
    ? { ...CONSERVATIVE_CAPABILITIES }
    : (() => {
        for (const entry of REGISTRY) {
          if (entry.match.test(id)) return { ...entry.caps };
        }
        return { ...CONSERVATIVE_CAPABILITIES };
      })();
  if (overrides?.contextWindow !== undefined && Number.isFinite(overrides.contextWindow) && overrides.contextWindow > 0) {
    base.contextWindow = Math.floor(overrides.contextWindow);
  }
  if (overrides?.maxOutput !== undefined && Number.isFinite(overrides.maxOutput) && overrides.maxOutput > 0) {
    base.maxOutput = Math.floor(overrides.maxOutput);
  }
  return base;
}

export function estimateCostUsd(
  model: string | undefined,
  inputTokens: number,
  outputTokens: number,
): number | undefined {
  const caps = getModelCapabilities(model);
  if (caps.inputPricePerMtok === undefined || caps.outputPricePerMtok === undefined) return undefined;
  return (inputTokens * caps.inputPricePerMtok + outputTokens * caps.outputPricePerMtok) / 1_000_000;
}
