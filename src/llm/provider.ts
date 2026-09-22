import OpenAI from "openai";
import { createOpenAIClient, createResponder, type Responder } from "./client.js";
import { createChatResponder, type MinimalChatClient } from "./chatProvider.js";
import { SYSTEM_PROMPT } from "../agent/prompt.js";

export type ProviderKind = "openai-responses" | "openai-chat";

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
  if (env.OPENAI_API_KEY) return env.OPENAI_API_KEY;
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
 */
export function describeProviderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  overrides?: ProviderOverrides,
): ProviderInfo & { needsKey: boolean } {
  const model = overrides?.model ?? env.MODEL ?? "gpt-5.6-luna";
  const baseURL = (overrides?.baseURL ?? env.OPENAI_BASE_URL?.trim()) || undefined;
  const explicit = (overrides?.provider ?? env.LLM_PROVIDER ?? "").trim().toLowerCase();

  const useChat =
    explicit === "chat" ||
    explicit === "openai-compatible" ||
    explicit === "compatible" ||
    (explicit === "" && !!baseURL);

  if (!useChat) return { kind: "openai-responses", model, needsKey: !env.OPENAI_API_KEY };
  return { kind: "openai-chat", model, baseURL, needsKey: !env.OPENAI_API_KEY && !baseURL };
}
/**
 * Build the live responder. Throws MissingApiKeyError when a key is
 * required but absent — callers should catch it and show setup help,
 * never a stack trace. Free routes: Ollama (local, no key), Groq /
 * Gemini / OpenRouter free tier (key + baseURL + MODEL).
 */
export function createProviderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  overrides?: ProviderOverrides,
): { responder: Responder; info: ProviderInfo } {
  const described = describeProviderFromEnv(env, overrides);

  if (described.kind === "openai-responses") {
    const client = createOpenAIClient(resolveApiKey(env));
    return {
      responder: createResponder(client, { model: described.model, instructions: SYSTEM_PROMPT }),
      info: { kind: described.kind, model: described.model },
    };
  }

  const client = new OpenAI({
    apiKey: resolveApiKey(env, described.baseURL),
    ...(described.baseURL ? { baseURL: described.baseURL } : {}),
  });
  return {
    responder: createChatResponder(client as unknown as MinimalChatClient, {
      model: described.model,
      systemPrompt: SYSTEM_PROMPT,
    }),
    info: { kind: described.kind, model: described.model, baseURL: described.baseURL },
  };
}
