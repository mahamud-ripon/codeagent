import type { Provider } from "./stream.js";
import type { AgentEvent } from "./events.js";
import type { ResponsesCreateResult } from "./client.js";
import type { StreamRequest } from "./events.js";

/**
 * Consume a Provider stream, emitting text/thinking/usage AgentEvents
 * incrementally (ML-1), and collapse to the legacy Responder result.
 */
export async function collectStreamingWithEmit(
  provider: Provider,
  req: StreamRequest,
  emit: (e: AgentEvent) => void,
): Promise<ResponsesCreateResult> {
  let text = "";
  let thinking = "";
  let finishReason: string | undefined;
  let usage: ResponsesCreateResult["usage"];
  const output: ResponsesCreateResult["output"] = [];
  const calls = new Map<string, { name: string; arguments: string }>();

  for await (const event of provider.stream(req)) {
    switch (event.type) {
      case "text_delta":
        text += event.text;
        emit({ type: "text_delta", text: event.text });
        break;
      case "thinking_delta":
        thinking += event.text;
        emit({ type: "thinking_delta", text: event.text });
        break;
      case "tool_call_start":
        calls.set(event.id, { name: event.name, arguments: "" });
        break;
      case "tool_call_delta": {
        const acc = calls.get(event.id) ?? { name: "unknown", arguments: "" };
        acc.arguments += event.argumentsDelta;
        calls.set(event.id, acc);
        break;
      }
      case "tool_call_end":
        calls.set(event.id, { name: event.name, arguments: event.arguments });
        break;
      case "usage":
        usage = { input: event.input, output: event.output, cachedInput: event.cachedInput };
        emit({ type: "usage", input: event.input, output: event.output, cachedInput: event.cachedInput });
        break;
      case "stop":
        finishReason = event.finishReason;
        break;
      default:
        break;
    }
  }

  if (text) output.push({ type: "message", content: text });
  for (const [id, call] of calls) {
    // Mid-stream cut leaves a start+delta with no end and truncated JSON.
    // Never emit corrupt arguments downstream (JSON.parse fail → no-op loop);
    // throw retryable instead so the outer withProviderRetry retries intact.
    try {
      if (call.arguments.trim()) JSON.parse(call.arguments);
    } catch {
      throw new Error(`Chat stream truncated mid-tool-call (${call.name}); retryable`);
    }
    output.push({ type: "function_call", call_id: id, name: call.name, arguments: call.arguments });
  }
  if (output.length === 0 && finishReason === undefined) {
    throw new Error("Chat stream ended with no output (truncated); retryable");
  }
  return {
    output,
    output_text: text,
    reasoning_text: thinking.trim() || undefined,
    finish_reason: finishReason,
    usage,
  };
}
