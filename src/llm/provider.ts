import OpenAI from "openai";
import { createOpenAIClient, createResponder, type Responder } from "./client.js";
import { createChatResponder, type MinimalChatClient } from "./chatProvider.js";
import { providerToResponder, type Provider } from "./stream.js";
import { createStreamingProvider } from "./streamingProvider.js";
import { SYSTEM_PROMPT } from "../agent/prompt.js";
import { buildSystemPrompt, promptFamilyForModel } from "../agent/promptSections.js";
import { isSmallModel } from "./smallModel.js";
import { resolveSecretSync } from "./keychain.js";

export type ProviderKind = "openai-responses" | "openai-chat" | "anthropic" | "gemini";

/** Single source of truth for the default model id (overridable via $MODEL). */
export const DEFAULT_MODEL = "gpt-5.6-luna";

/**
 * Versioned modular prompt (AG-2) for a model id.
 * Family routing: claude → anthropic notes, gemini → gemini notes,
 * small/cheap models → small suffix. Falls back to the legacy
 * SYSTEM_PROMPT shape for the default family so existing tests keep passing.
 */
export function systemPromptForModel(model?: string, opts?: { smallModel?: boolean }): string {
  const family = promptFamilyForModel(model);
  const small = opts?.smallModel ?? isSmallModel(model);
  try {
    return buildSystemPrompt({ family, small });
  } catch {
    return SYSTEM_PROMPT;
  }
}

function resolveKeySync(env: NodeJS.ProcessEnv, key: string): string | undefined {
  if (env[key]) return env[key];
  // ML-7 file fallback applies at runtime only (process.env). Explicit env
  // objects in tests stay pure so MissingApiKeyError is deterministic.
  if (env !== process.env) return undefined;
  try {
    return resolveSecretSync(key);
  } catch {
    return undefined;
  }
}

function hasConfiguredKey(env: NodeJS.ProcessEnv, key: string, altKey?: string): boolean {
  if (env[key]) return true;
  if (altKey && env[altKey]) return true;
  // Runtime-only file fallback (see resolveKeySync): tests pass {} and
  // must observe needsKey:true deterministically.
  if (env !== process.env) return false;
  try {
    if (resolveSecretSync(key)) return true;
    if (altKey && resolveSecretSync(altKey)) return true;
  } catch {
    // file read is best-effort
  }
  return false;
}

export interface ProviderInfo {
  kind: ProviderKind;
  model: string;
  /** Set for OpenAI-compatible endpoints (Ollama, Groq, OpenRouter…). */
  baseURL?: string;
}

export class MissingApiKeyError extends Error {
  constructor() {
    super(
      "No API key configured. Run /key <api-key> once (saved globally to ~/.codeagent/.env), " +
        "or set OPENAI_API_KEY in the environment. " +
        "Local Ollama needs no key — just /endpoint http://localhost:11434/v1",
    );
    this.name = "MissingApiKeyError";
  }
}

function resolveApiKey(env: NodeJS.ProcessEnv, baseURL?: string): string {
  const fromEnv = resolveKeySync(env, "OPENAI_API_KEY");
  if (fromEnv) return fromEnv;
  if (baseURL) return "ollama"; // local servers typically ignore the key
  throw new MissingApiKeyError();
}

export interface ProviderOverrides {
  model?: string;
  /** Force backend: "openai" (Responses) or "chat" (Chat Completions). */
  provider?: string;
  /** Force OpenAI-compatible endpoint (implies chat). */
  baseURL?: string;
}

/**
 * Pure selection logic — never touches the network or API keys, so the
 * REPL banner and /status can render before any key is configured.
 * Native kinds: LLM_PROVIDER=anthropic|gemini select native adapters (ML-1).
 */
export function describeProviderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  overrides?: ProviderOverrides,
): ProviderInfo & { needsKey: boolean } {
  const model = overrides?.model ?? env.MODEL ?? DEFAULT_MODEL;
  const baseURL = (overrides?.baseURL ?? env.OPENAI_BASE_URL?.trim()) || undefined;
  const explicit = (overrides?.provider ?? env.LLM_PROVIDER ?? "").trim().toLowerCase();

  if (explicit === "anthropic") {
    return { kind: "anthropic", model, needsKey: !hasConfiguredKey(env, "ANTHROPIC_API_KEY") };
  }
  if (explicit === "gemini") {
    return { kind: "gemini", model, needsKey: !hasConfiguredKey(env, "GEMINI_API_KEY", "GOOGLE_API_KEY") };
  }

  const useChat =
    explicit === "chat" ||
    explicit === "openai-compatible" ||
    explicit === "compatible" ||
    (explicit === "" && !!baseURL);

  if (!useChat) return { kind: "openai-responses", model, needsKey: !hasConfiguredKey(env, "OPENAI_API_KEY") };
  return { kind: "openai-chat", model, baseURL, needsKey: !hasConfiguredKey(env, "OPENAI_API_KEY") && !baseURL };
}
/**
 * Build the live responder. Throws MissingApiKeyError when a key is
 * required but absent — callers should catch it and show setup help,
 * never a stack trace. Free routes: Ollama (local, no key), Groq /
 * Gemini / OpenRouter free tier (key + baseURL + MODEL).
 *
 * ML-1 wiring: also returns a true streaming `providerInstance` for every
 * backend (Responses / Anthropic / Gemini / OpenAI-compatible chat SSE)
 * so the agent loop and REPL can stream deltas by default. The one-shot
 * Responder stays as fallback for tests/offline.
 * ML-7 wiring: keys resolve via env → keychain/0600 file (resolveSecretSync).
 * AG-2 wiring: system prompt is the versioned family prompt for the model.
 */
export function createProviderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  overrides?: ProviderOverrides,
): { responder: Responder; info: ProviderInfo; providerInstance?: Provider; systemPrompt: string } {
  const described = describeProviderFromEnv(env, overrides);
  const systemPrompt = systemPromptForModel(described.model);

  if (described.kind === "openai-responses") {
    const apiKey = resolveApiKey(env, undefined);
    const client = createOpenAIClient(apiKey);
    // Default path streams via Responses-SSE when a key is present;
    // the one-shot Responder stays as fallback for tests/offline.
    let providerInstance: Provider | undefined;
    try {
      providerInstance = createStreamingProvider({
        kind: "openai-responses",
        model: described.model,
        apiKey,
        systemPrompt,
      });
    } catch {
      providerInstance = undefined;
    }
    return {
      responder: createResponder(client, { model: described.model, instructions: systemPrompt }),
      info: { kind: described.kind, model: described.model },
      providerInstance,
      systemPrompt,
    };
  }

  if (described.kind === "anthropic" || described.kind === "gemini") {
    // Native adapters stream via fetch; the Responder shim below preserves the
    // legacy non-streaming call shape until the loop migrates fully (ML-1).
    // Until a key is configured, return a fail-closed responder that throws
    // MissingApiKeyError instead of hitting the network.
    const key = described.kind === "anthropic"
      ? resolveKeySync(env, "ANTHROPIC_API_KEY")
      : (resolveKeySync(env, "GEMINI_API_KEY") ?? resolveKeySync(env, "GOOGLE_API_KEY"));
    if (!key) {
      const missing = (): Promise<never> => { throw new MissingApiKeyError(); };
      return { responder: missing, info: { kind: described.kind, model: described.model }, systemPrompt };
    }
    const provider = createStreamingProvider({
      kind: described.kind,
      model: described.model,
      apiKey: key,
      systemPrompt,
    });
    return { responder: providerToResponder(provider, systemPrompt), info: { kind: described.kind, model: described.model }, providerInstance: provider, systemPrompt };
  }

  const apiKey = resolveApiKey(env, described.baseURL);
  const client = new OpenAI({
    apiKey,
    ...(described.baseURL ? { baseURL: described.baseURL } : {}),
  });
  // ML-1: chat/compat streams natively via Chat Completions SSE (Ollama,
  // Groq, OpenRouter…). A local baseURL needs no key ("ollama" placeholder).
  let providerInstance: Provider | undefined;
  try {
    providerInstance = createStreamingProvider({
      kind: "openai-chat",
      model: described.model,
      apiKey,
      baseURL: described.baseURL,
      systemPrompt,
    });
  } catch {
    providerInstance = undefined;
  }
  return {
    responder: createChatResponder(client as unknown as MinimalChatClient, {
      model: described.model,
      systemPrompt,
    }),
    info: { kind: described.kind, model: described.model, baseURL: described.baseURL },
    providerInstance,
    systemPrompt,
  };
}
