import type { AgentReporter } from "./reporter.js";
import type { AgentEvent } from "../../llm/events.js";

/**
 * ARCH-1: translate the AgentEvent stream into legacy AgentReporter callbacks
 * so the readline REPL keeps working while UIs migrate to events (ML-1).
 */
export function createReporterAdapter(reporter: AgentReporter): (event: AgentEvent) => void {
  let buffer = "";
  let toolStartAt = 0;
  const flushText = (): void => {
    const text = buffer.trim();
    buffer = "";
    if (text && reporter.onThinking) reporter.onThinking(text, 0);
    else if (text) reporter.onProgressMessage(text);
  };
  return (event: AgentEvent) => {
    switch (event.type) {
      case "turn_start":
        reporter.onIterationStart(event.turn, event.turn, "work");
        break;
      case "text_delta":
        buffer += event.text;
        // Flush on sentence-ish boundaries so the legacy UI streams instead of blocking.
        if (/[.!?\n]\s*$/.test(event.text) || buffer.length > 400) flushText();
        break;
      case "thinking_delta":
        reporter.onThinking?.(event.text, 0);
        break;
      case "tool_start":
        flushText();
        toolStartAt = Date.now();
        reporter.onToolStart(event.name, (event.args ?? {}) as Record<string, unknown>);
        break;
      case "tool_output_delta":
        // Legacy reporter has no delta channel; accumulate silently.
        break;
      case "tool_end":
        reporter.onToolComplete("tool", { id: event.id }, event.output, event.ok, event.ms ?? Date.now() - toolStartAt);
        break;
      case "todo_update":
        reporter.onTodoUpdate?.(event.todos as never[], undefined);
        break;
      case "usage":
        reporter.setEstimatedTokens?.(event.input + event.output);
        break;
      case "compaction":
        reporter.onProgressMessage(`Compacted context: ${event.before} → ${event.after} chars.`);
        break;
      case "error":
        reporter.onError(event.message);
        break;
      case "done":
        flushText();
        reporter.stop();
        break;
      default:
        break;
    }
  };
}
