/** Normalized model stream. Adapters emit these; the agent does not see provider JSON. */
export type ProviderEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "tool_call_start"; id: string; name: string }
  | { type: "tool_call_delta"; id: string; argumentsDelta: string }
  | { type: "tool_call_end"; id: string; name: string; arguments: string }
  | { type: "usage"; input: number; output: number; cachedInput?: number }
  | { type: "stop"; finishReason: string };

/**
 * The only contract between the agent core and any UI (legacy REPL, Ink, headless).
 * `respond` callbacks are attached by the runner; JSON logs omit them.
 */
export type AgentEvent =
  | { type: "turn_start"; turn: number }
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "tool_start"; id: string; name: string; args: unknown }
  | { type: "tool_output_delta"; id: string; chunk: string }
  | { type: "tool_end"; id: string; ok: boolean; output: string; ms: number }
  | {
      type: "permission_request";
      id: string;
      tool: string;
      preview: string;
    }
  | { type: "todo_update"; todos: unknown[] }
  | { type: "plan_proposed"; plan: string }
  | { type: "usage"; input: number; output: number; cachedInput?: number; costUsd?: number }
  | { type: "compaction"; before: number; after: number }
  | { type: "error"; message: string; retryable: boolean }
  | { type: "done"; result: unknown };

export interface StreamRequest {
  system: string;
  messages: unknown[];
  tools: boolean;
  signal?: AbortSignal;
}
