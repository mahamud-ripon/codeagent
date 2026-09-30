import type { Provider } from "./stream.js";
import { scriptedProvider } from "./stream.js";
import { getModelCapabilities } from "./capabilities.js";
import type { ProviderKind } from "./provider.js";
import { createResponsesStreamProvider } from "./responsesStream.js";
import { createAnthropicProvider } from "./anthropic.js";
import { createGeminiProvider } from "./gemini.js";

export interface StreamingProviderOptions {
  kind: ProviderKind;
  model: string;
  apiKey?: string;
  baseURL?: string;
  systemPrompt?: string;
  fetchImpl?: typeof fetch;
}

/**
 * Build a true streaming Provider for every supported backend (ML-1).
 * Chat/compat backends without a native fetch adapter fall back to a
 * conservative scripted stub so callers always get a Provider; the live
 * chat path is assembled in chatProvider.ts and provider.ts.
 */
export function createStreamingProvider(opts: StreamingProviderOptions): Provider {
  const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY ?? process.env.GEMINI_API_KEY ?? process.env.OPENAI_API_KEY ?? "";
  switch (opts.kind) {
    case "anthropic":
      return createAnthropicProvider({ model: opts.model, apiKey, baseURL: opts.baseURL, systemPrompt: opts.systemPrompt, fetchImpl: opts.fetchImpl });
    case "gemini":
      return createGeminiProvider({ model: opts.model, apiKey, baseURL: opts.baseURL, systemPrompt: opts.systemPrompt, fetchImpl: opts.fetchImpl });
    case "openai-responses":
      return createResponsesStreamProvider({ model: opts.model, apiKey, baseURL: opts.baseURL, instructions: opts.systemPrompt, fetchImpl: opts.fetchImpl });
    case "openai-chat":
    default:
      // Live chat streaming is assembled per-call in chatProvider; return a
      // capability-correct stub so UI code can rely on the interface.
      return scriptedProvider([], getModelCapabilities(opts.model));
  }
}
