import type { Provider } from "./stream.js";
import type { ProviderKind } from "./provider.js";
import { createResponsesStreamProvider } from "./responsesStream.js";
import { createAnthropicProvider } from "./anthropic.js";
import { createGeminiProvider } from "./gemini.js";
import { createChatStreamProvider } from "./chatProvider.js";

export interface StreamingProviderOptions {
  kind: ProviderKind;
  model: string;
  apiKey?: string;
  baseURL?: string;
  systemPrompt?: string;
  fetchImpl?: typeof fetch;
}

/**
 * Build a true streaming Provider for every supported backend (ML-1),
 * including OpenAI-compatible chat endpoints (Ollama, Groq, OpenRouter…).
 * The one-shot Responder in chatProvider.ts stays as the offline fallback.
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
      return createChatStreamProvider({ model: opts.model, apiKey, baseURL: opts.baseURL, systemPrompt: opts.systemPrompt, fetchImpl: opts.fetchImpl });
  }
}
