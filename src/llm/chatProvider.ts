import type OpenAI from "openai";
import { toChatTools } from "./tools.js";
import type { ResponsesCreateResult, Responder, ResponderOptions } from "./client.js";

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
            reasoning_content?: string | null;
            reasoning?: string | null;
            thought?: string | null;
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

/**
 * Extracts model thinking / reasoning text from a chat response message.
 * Supports:
 * - message.reasoning_content (DeepSeek-R1, Groq, Ollama, OpenRouter, vLLM)
 * - message.reasoning (OpenRouter, Together)
 * - message.thought (Gemini compat)
 * - <think>...</think>, <thought>...</thought>, <thinking>...</thinking> tags inside content
 * - Text generated alongside tool_calls (represents the model's rationale before tool execution)
 */
export function extractThinking(msg: {
  content?: string | null;
  reasoning_content?: string | null;
  reasoning?: string | null;
  thought?: string | null;
  tool_calls?: unknown[];
}): { content: string; thinking?: string } {
  const parts: string[] = [];
  let content = msg.content ?? "";

  // 1. Direct reasoning fields
  if (typeof msg.reasoning_content === "string" && msg.reasoning_content.trim()) {
    parts.push(msg.reasoning_content.trim());
  }
  if (typeof msg.reasoning === "string" && msg.reasoning.trim()) {
    parts.push(msg.reasoning.trim());
  }
  if (typeof msg.thought === "string" && msg.thought.trim()) {
    parts.push(msg.thought.trim());
  }

  // 2. Extract <think>...</think>, <thought>...</thought>, or <thinking>...</thinking>
  const thinkRegex = /<(think|thought|thinking)>([\s\S]*?)<\/\1>/gi;
  let match: RegExpExecArray | null;
  while ((match = thinkRegex.exec(content)) !== null) {
    if (match[2].trim()) {
      parts.push(match[2].trim());
    }
  }
  content = content.replace(thinkRegex, "").trim();

  // 3. Handle unclosed <think> tag (in case of stream cutoff)
  const unclosedThink = /<(think|thought|thinking)>([\s\S]*)$/i;
  const unclosedMatch = unclosedThink.exec(content);
  if (unclosedMatch) {
    if (unclosedMatch[2].trim()) {
      parts.push(unclosedMatch[2].trim());
    }
    content = content.replace(unclosedThink, "").trim();
  }

  // 4. If tools are called and content has text, that text is the model's pre-tool thought
  if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0 && content) {
    parts.push(content);
  }

  const thinking = parts.join("\n\n").trim();
  return {
    content,
    thinking: thinking || undefined,
  };
}

export function createChatResponder(
  client: MinimalChatClient,
  args: { model: string; systemPrompt: string },
): Responder {
  return async (input: unknown[], options?: ResponderOptions) => {
    const messages: ChatMessage[] = [
      { role: "system", content: args.systemPrompt },
      ...responsesHistoryToChatMessages(input),
    ];

    const useTools = options?.tools ?? true;
    const completion = await client.chat.completions.create({
      model: args.model,
      messages,
      ...(useTools ? { tools: toChatTools() as unknown as ChatTool[] } : {}),
    });

    const msg = completion.choices[0]?.message;
    if (!msg) throw new Error("Chat provider returned no choices.");

    const { content: text, thinking } = extractThinking(msg);
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
    return { output, output_text: text, reasoning_text: thinking };
  };
}
