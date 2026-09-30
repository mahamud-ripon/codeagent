import type { ResponsesCreateResult } from "./client.js";

/**
 * Loose view of an OpenAI Responses API result.
 * The SDK type is wide; the agent only needs these fields.
 */
export interface ResponsesApiPayload {
  output?: Array<Record<string, unknown>>;
  output_text?: string;
  status?: string;
  incomplete_details?: { reason?: string } | null;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    input_tokens_details?: { cached_tokens?: number };
    prompt_tokens?: number;
    completion_tokens?: number;
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function textFromParts(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(isRecord)
    .map((part) => {
      if (typeof part.text === "string") return part.text;
      if (typeof part.refusal === "string") return part.refusal;
      return "";
    })
    .join("");
}

function reasoningTextFromItem(item: Record<string, unknown>): string {
  const parts: string[] = [];
  const fromContent = textFromParts(item.content);
  if (fromContent.trim()) parts.push(fromContent.trim());
  if (Array.isArray(item.summary)) {
    for (const entry of item.summary) {
      if (!isRecord(entry)) continue;
      const text = typeof entry.text === "string" ? entry.text : textFromParts(entry);
      if (text.trim()) parts.push(text.trim());
    }
  }
  return parts.join("\n\n").trim();
}

/**
 * Preserve message text, reasoning items, and finish reason.
 * The previous mapper kept only function-call fields, so assistant
 * text disappeared from history and length-recovery never fired.
 */
export function mapResponsesApiResult(response: ResponsesApiPayload): ResponsesCreateResult {
  const output: ResponsesCreateResult["output"] = [];
  const reasoningParts: string[] = [];

  for (const item of response.output ?? []) {
    const type = String(item.type ?? "");
    if (type === "message") {
      const content = textFromParts(item.content);
      output.push({
        type,
        role: typeof item.role === "string" ? item.role : "assistant",
        content,
      });
      continue;
    }
    if (type === "function_call") {
      output.push({
        type,
        call_id: typeof item.call_id === "string" ? item.call_id : undefined,
        name: typeof item.name === "string" ? item.name : undefined,
        arguments: typeof item.arguments === "string" ? item.arguments : undefined,
      });
      continue;
    }
    if (type === "reasoning") {
      const text = reasoningTextFromItem(item);
      if (text) reasoningParts.push(text);
      output.push({
        type,
        id: typeof item.id === "string" ? item.id : undefined,
        summary: item.summary,
        content: item.content,
        encrypted_content:
          typeof item.encrypted_content === "string" ? item.encrypted_content : undefined,
        status: typeof item.status === "string" ? item.status : undefined,
      });
      continue;
    }
    output.push({
      type,
      call_id: typeof item.call_id === "string" ? item.call_id : undefined,
      name: typeof item.name === "string" ? item.name : undefined,
      arguments: typeof item.arguments === "string" ? item.arguments : undefined,
      content: item.content,
      id: typeof item.id === "string" ? item.id : undefined,
    });
  }

  const messageText = output
    .filter((item) => item.type === "message")
    .map((item) => (typeof item.content === "string" ? item.content : textFromParts(item.content)))
    .join("\n")
    .trim();

  const incomplete = response.incomplete_details?.reason;
  let finish_reason = "stop";
  if (
    response.status === "incomplete" &&
    (incomplete === "max_output_tokens" || incomplete === "length")
  ) {
    finish_reason = "length";
  } else if (output.some((item) => item.type === "function_call")) {
    finish_reason = "tool_calls";
  } else if (response.status && response.status !== "completed") {
    finish_reason = response.status;
  }

  const usage = response.usage;
  const inputTokens = usage?.input_tokens ?? usage?.prompt_tokens;
  const outputTokens = usage?.output_tokens ?? usage?.completion_tokens;

  return {
    output,
    output_text: (response.output_text ?? messageText).trim(),
    reasoning_text: reasoningParts.join("\n\n").trim() || undefined,
    finish_reason,
    usage:
      inputTokens !== undefined || outputTokens !== undefined
        ? {
            input: inputTokens ?? 0,
            output: outputTokens ?? 0,
            cachedInput: usage?.input_tokens_details?.cached_tokens,
          }
        : undefined,
  };
}
