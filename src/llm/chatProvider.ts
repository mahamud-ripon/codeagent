import type OpenAI from "openai";
import { toChatTools } from "./tools.js";
import type { ResponsesCreateResult, Responder } from "./client.js";

/**
 * Chat Completions provider — the free-model route.
 *
 * Any OpenAI-compatible endpoint works here: Ollama, LM Studio, vLLM,
 * Groq, OpenRouter, Gemini's OpenAI-compat endpoint, DeepSeek, etc.
 * The agent loop is untouched: this responder translates the shared
 * Responses-style history into chat messages on every turn and maps
 * the chat result back to { output, output_text }.
 */

type ChatMessage = OpenAI.ChatCompletionMessageParam;
type ChatTool = OpenAI.ChatCompletionTool;

/** Narrow structural client so tests can inject a fake. */
export interface MinimalChatClient {
  chat: {
    completions: {
      create(body: {
        model: string;
        messages: ChatMessage[];
        tools?: ChatTool[];
      }): Promise<{
        choices: Array<{
          message: {
            content?: string | null;
            tool_calls?: Array<{
              id: string;
              type?: string;
              function: { name: string; arguments: string };
            }>;
          };
        }>;
      }>;
    };
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function extractMessageText(item: Record<string, unknown>): string {
  const content = item.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter(isRecord)
      .filter((p) => p.type === "output_text" || p.type === "text")
      .map((p) => (typeof p.text === "string" ? p.text : ""))
      .join("");
  }
  return "";
}

/**
 * Convert the agent's Responses-style history into chat messages.
 * Handles: {role,user} items, function_call / function_call_output
 * pairs, message items carrying assistant text, and skips anything
 * the chat API cannot represent (reasoning items, etc.).
 */
export function responsesHistoryToChatMessages(input: unknown[]): ChatMessage[] {
  const messages: ChatMessage[] = [];
  let pendingText = "";
  let pendingCalls: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }> = [];

  const flushAssistant = (): void => {
    if (!pendingText && pendingCalls.length === 0) return;
    messages.push({
      role: "assistant",
      content: pendingText || null,
      ...(pendingCalls.length > 0 ? { tool_calls: pendingCalls } : {}),
    } as ChatMessage);
    pendingText = "";
    pendingCalls = [];
  };

  for (const raw of input) {
    if (!isRecord(raw)) continue;

    if (raw.type === "function_call") {
      pendingCalls.push({
        id: String(raw.call_id ?? `call-${pendingCalls.length}`),
        type: "function",
        function: {
          name: String(raw.name ?? "unknown"),
          arguments: typeof raw.arguments === "string" ? raw.arguments : "{}",
        },
      });
      continue;
    }

    if (raw.type === "function_call_output") {
      // tool_calls must precede their tool responses.
      flushAssistant();
      messages.push({
        role: "tool",
        tool_call_id: String(raw.call_id ?? ""),
        content: String(raw.output ?? ""),
      } as ChatMessage);
      continue;
    }

    if (raw.type === "message") {
      const text = extractMessageText(raw);
      if (text) pendingText += (pendingText ? "\n" : "") + text;
      continue;
    }

    if (raw.role === "user" || raw.role === "system") {
      flushAssistant();
      messages.push({
        role: raw.role,
        content: typeof raw.content === "string" ? raw.content : String(raw.content ?? ""),
      } as ChatMessage);
      continue;
    }

    if (raw.role === "assistant") {
      flushAssistant();
      if (typeof raw.content === "string" && raw.content) {
        messages.push({ role: "assistant", content: raw.content });
      }
      continue;
    }

    // Unknown item (reasoning, etc.) — not representable in chat history.
  }

  flushAssistant();
  return messages;
}

export function createChatResponder(
  client: MinimalChatClient,
  args: { model: string; systemPrompt: string },
): Responder {
  return async (input: unknown[]) => {
    const messages: ChatMessage[] = [
      { role: "system", content: args.systemPrompt },
      ...responsesHistoryToChatMessages(input),
    ];

    const completion = await client.chat.completions.create({
      model: args.model,
      messages,
      tools: toChatTools() as unknown as ChatTool[],
    });

    const msg = completion.choices[0]?.message;
    if (!msg) throw new Error("Chat provider returned no choices.");

    const text = msg.content ?? "";
    const output: ResponsesCreateResult["output"] = [];
    if (text) output.push({ type: "message", content: text });
    for (const tc of msg.tool_calls ?? []) {
      output.push({
        type: "function_call",
        call_id: tc.id,
        name: tc.function.name,
        arguments: tc.function.arguments,
      });
    }
    return { output, output_text: text };
  };
}
