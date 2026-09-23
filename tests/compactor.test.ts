import { describe, expect, it } from "vitest";
import { compactHistory } from "../src/agent/compactor.js";

describe("compactHistory", () => {
  it("keeps recent tool outputs and prunes older tool outputs", () => {
    const input = [
      { role: "user", content: "Task start" },
      { type: "function_call", call_id: "c1", name: "list_files" },
      { type: "function_call_output", call_id: "c1", output: "A".repeat(1000) },
      { type: "function_call", call_id: "c2", name: "read_file" },
      { type: "function_call_output", call_id: "c2", output: "B".repeat(1000) },
      { type: "function_call", call_id: "c3", name: "read_file" },
      { type: "function_call_output", call_id: "c3", output: "C".repeat(1000) },
    ];

    const compacted = compactHistory(input, { keepRecentToolOutputs: 2 });
    expect(compacted).toHaveLength(7);

    // Oldest tool output (c1) should be pruned
    const c1Output = (compacted[2] as { output: string }).output;
    expect(c1Output).toContain("pruned");
    expect(c1Output.length).toBeLessThan(400);

    // Recent tool outputs (c2 and c3) should be preserved
    const c2Output = (compacted[4] as { output: string }).output;
    expect(c2Output).toBe("B".repeat(1000));
    const c3Output = (compacted[6] as { output: string }).output;
    expect(c3Output).toBe("C".repeat(1000));
  });

  it("applies sliding window compaction when total characters exceed maxTotalChars", () => {
    const input: unknown[] = [
      { role: "user", content: "Initial repo context" },
      { role: "assistant", content: "Turn 1 answer" },
      { role: "user", content: "Turn 2 question" },
      { role: "assistant", content: "Turn 2 answer" },
      { role: "user", content: "Turn 3 question" },
      { role: "assistant", content: "Turn 3 answer" },
      { role: "user", content: "Turn 4 question" },
      { role: "assistant", content: "Turn 4 answer" },
      { role: "user", content: "Turn 5 question" },
      { role: "assistant", content: "Turn 5 answer" },
      { role: "user", content: "Turn 6 task" },
    ];

    const compacted = compactHistory(input, { aggressive: true, maxTotalChars: 100 });
    // First message preserved, last 6 preserved, middle summarized with topics
    expect((compacted[0] as { content: string }).content).toBe("Initial repo context");
    expect((compacted[1] as { content: string }).content).toContain("compacted");
    expect((compacted[1] as { content: string }).content).toContain("Turn 2 question");
    expect(compacted.length).toBeLessThan(input.length);
  });

  it("strictly preserves user and assistant dialogue during /compact if within token budget", () => {
    const input = [
      { role: "user", content: "hello" },
      { type: "message", content: "Hi there! How can I help?" },
      { role: "user", content: "what is codeagent?" },
      {
        type: "message",
        content: "Codeagent provides 1. Context-aware code search, 2. Targeted edits.",
      },
      { role: "user", content: "can you list files?" },
      { type: "function_call", call_id: "c1", name: "list_files", arguments: JSON.stringify({ path: "." }) },
      { type: "function_call_output", call_id: "c1", output: "src/\npackage.json\n".repeat(50) },
      { type: "message", content: "Here is the project tree." },
      { role: "user", content: "read App.tsx" },
      { type: "function_call", call_id: "c2", name: "read_file", arguments: JSON.stringify({ path: "App.tsx" }) },
      { type: "function_call_output", call_id: "c2", output: "export default function App() {}" },
      { type: "message", content: "Read App.tsx successfully." },
    ];

    // Trigger aggressive compaction as done by /compact
    const compacted = compactHistory(input, { aggressive: true, keepRecentToolOutputs: 1 });

    // Dialogue items MUST NOT be dropped
    expect(compacted.some((item) => (item as { content?: string }).content?.includes("what is codeagent?"))).toBe(true);
    expect(
      compacted.some((item) =>
        (item as { content?: string }).content?.includes("Context-aware code search"),
      ),
    ).toBe(true);

    // Older tool output (c1) should be micro-pruned with metadata
    const c1Output = compacted.find(
      (item) =>
        (item as { type?: string }).type === "function_call_output" &&
        (item as { call_id?: string }).call_id === "c1",
    ) as { output: string };
    expect(c1Output.output).toContain("list_files");
    expect(c1Output.output).toContain("pruned");

    // Most recent tool output (c2) should be preserved
    const c2Output = compacted.find(
      (item) =>
        (item as { type?: string }).type === "function_call_output" &&
        (item as { call_id?: string }).call_id === "c2",
    ) as { output: string };
    expect(c2Output.output).toBe("export default function App() {}");
  });

  it("preserves repository context and active task user message when session started with greetings", () => {
    const input = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "Hello! How can I help you?" },
      { role: "user", content: "hello again" },
      { role: "assistant", content: "Hi again! What would you like to work on?" },
      { role: "system", content: "<repository>\nsrc/components/Desktop.tsx\n</repository>" },
      { role: "user", content: "can you create a test file?" },
      { role: "assistant", content: "Sure, what framework?" },
      { role: "user", content: "Vitest" },
      { role: "assistant", content: "Which component?" },
      { role: "user", content: "Desktop" },
      { type: "function_call", call_id: "c1", name: "read_file", arguments: JSON.stringify({ path: "Desktop.tsx" }) },
      { type: "function_call_output", call_id: "c1", output: "export const Desktop = () => {};" },
      { type: "function_call", call_id: "c2", name: "view_file", arguments: JSON.stringify({ path: "Desktop.tsx" }) },
      { type: "function_call_output", call_id: "c2", output: "export const Desktop = () => {};" },
      { type: "function_call", call_id: "c3", name: "search", arguments: JSON.stringify({ query: "vitest" }) },
      { type: "function_call_output", call_id: "c3", output: "vitest match" },
    ];

    const compacted = compactHistory(input, { aggressive: true, maxTotalChars: 100 });

    // Anchor should be the repository context, NOT "hello"
    const firstItem = compacted[0] as { role?: string; content?: string };
    expect(firstItem.role).toBe("system");
    expect(firstItem.content).toContain("<repository>");

    // Compacted summary should capture earlier turns
    const summaryItem = compacted[1] as { role?: string; content?: string };
    expect(summaryItem.content).toContain("compacted");

    // The active user task ("Desktop") MUST be preserved
    expect(compacted.some((item) => (item as { content?: string }).content === "Desktop")).toBe(true);
  });

  it("ensures tool call and output boundary pairing is preserved during sliding window", () => {
    const input: unknown[] = [
      { role: "system", content: "<repository>root</repository>" },
      { role: "user", content: "Fix bug" },
      { role: "assistant", content: "Starting..." },
      { role: "user", content: "More info" },
      { role: "assistant", content: "Got it" },
      { role: "user", content: "Active task" },
      { type: "function_call", call_id: "c1", name: "read_file", arguments: JSON.stringify({ path: "a.ts" }) },
      { type: "function_call_output", call_id: "c1", output: "code A" },
      { type: "function_call", call_id: "c2", name: "read_file", arguments: JSON.stringify({ path: "b.ts" }) },
      { type: "function_call_output", call_id: "c2", output: "code B" },
    ];

    const compacted = compactHistory(input, { aggressive: true, maxTotalChars: 50 });

    // Verify that every function_call_output has its matching function_call in compacted
    const outputItems = compacted.filter(
      (item) => (item as { type?: string }).type === "function_call_output",
    ) as Array<{ call_id: string }>;

    for (const out of outputItems) {
      const hasCall = compacted.some(
        (item) =>
          (item as { type?: string }).type === "function_call" &&
          (item as { call_id?: string }).call_id === out.call_id,
      );
      expect(hasCall).toBe(true);
    }
  });
});


