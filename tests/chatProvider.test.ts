import { describe, expect, it } from "vitest";
import {
  createChatResponder,
  responsesHistoryToChatMessages,
  type MinimalChatClient,
} from "../src/llm/chatProvider.js";
import { createProviderFromEnv } from "../src/llm/provider.js";
import { toChatTools } from "../src/llm/tools.js";

describe("toChatTools", () => {
  it("converts all 11 tools to chat shape", () => {
    const chat = toChatTools();
    expect(chat).toHaveLength(11);
    expect(chat[0]).toMatchObject({
      type: "function",
      function: { name: "list_files" },
    });
    expect(chat.some((t) => t.function.name === "view_file")).toBe(true);
    expect(chat.some((t) => t.function.name === "view_symbol_outline")).toBe(true);
    expect(chat.some((t) => t.function.name === "run_subagent")).toBe(true);
  });
});

describe("responsesHistoryToChatMessages", () => {
  it("maps user + tool-call round trip", () => {
    const msgs = responsesHistoryToChatMessages([
      { role: "user", content: "Fix it" },
      { type: "function_call", call_id: "c1", name: "read_file", arguments: '{"path":"a.ts"}' },
      { type: "function_call_output", call_id: "c1", output: "content here" },
    ]);
    expect(msgs).toHaveLength(3);
    expect(msgs[0]).toMatchObject({ role: "user" });
    expect(msgs[1]).toMatchObject({ role: "assistant" });
    const assistant = msgs[1] as unknown as {
      tool_calls: Array<{ id: string; function: { name: string } }>;
    };
    expect(assistant.tool_calls[0].id).toBe("c1");
    expect(assistant.tool_calls[0].function.name).toBe("read_file");
    expect(msgs[2]).toMatchObject({ role: "tool", tool_call_id: "c1" });
  });

  it("carries assistant text through message items and skips reasoning", () => {
    const msgs = responsesHistoryToChatMessages([
      { type: "reasoning", content: "hmm" },
      { type: "message", content: "Looking at it" },
      { type: "function_call", call_id: "c1", name: "search", arguments: '{"query":"x"}' },
    ]);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ role: "assistant" });
  });
});

describe("createChatResponder", () => {
  type ChatReply = Awaited<ReturnType<MinimalChatClient["chat"]["completions"]["create"]>>;
  function fakeClient(reply: ChatReply): MinimalChatClient {
    return { chat: { completions: { create: async () => reply } } };
  }

  it("maps chat tool_calls back to function_call output", async () => {
    const client = fakeClient({
      choices: [
        {
          message: {
            content: "Reading now",
            tool_calls: [
              { id: "t1", type: "function", function: { name: "read_file", arguments: '{"path":"a"}' } },
            ],
          },
        },
      ],
    });
    const respond = createChatResponder(client, { model: "test", systemPrompt: "SYS" });
    const result = await respond([{ role: "user", content: "hi" }]);
    expect(result.output_text).toBe("Reading now");
    expect(result.output).toContainEqual({ type: "message", content: "Reading now" });
    expect(result.output).toContainEqual({
      type: "function_call",
      call_id: "t1",
      name: "read_file",
      arguments: '{"path":"a"}',
    });
  });

  it("prepends the system prompt without mutating history", async () => {
    let seen: unknown[] = [];
    const client: MinimalChatClient = {
      chat: {
        completions: {
          create: async (body) => {
            seen = body.messages;
            return { choices: [{ message: { content: "done" } }] };
          },
        },
      },
    };
    const respond = createChatResponder(client, { model: "m", systemPrompt: "SYS" });
    const history = [{ role: "user", content: "hi" }];
    await respond(history);
    expect(history).toHaveLength(1);
    expect(seen[0]).toMatchObject({ role: "system", content: "SYS" });
    expect(seen[1]).toMatchObject({ role: "user" });
  });

  it("extracts reasoning_content and <think> tags as thinking text", async () => {
    const client = fakeClient({
      choices: [
        {
          message: {
            content: "<think>Plan the fix</think>Here is the fix",
            reasoning_content: "DeepSeek model thoughts",
          },
        },
      ],
    });
    const respond = createChatResponder(client, { model: "deepseek-r1", systemPrompt: "SYS" });
    const result = await respond([{ role: "user", content: "hi" }]);
    expect(result.output_text).toBe("Here is the fix");
    expect(result.reasoning_text).toContain("DeepSeek model thoughts");
    expect(result.reasoning_text).toContain("Plan the fix");
  });
});

describe("createProviderFromEnv", () => {
  it("defaults to Responses API", () => {
    const { info } = createProviderFromEnv({ OPENAI_API_KEY: "k" } as NodeJS.ProcessEnv);
    expect(info.kind).toBe("openai-responses");
  });

  it("uses chat when a baseURL is set", () => {
    const { info } = createProviderFromEnv({
      OPENAI_BASE_URL: "http://localhost:11434/v1",
      MODEL: "qwen2.5-coder:7b",
    } as NodeJS.ProcessEnv);
    expect(info).toMatchObject({
      kind: "openai-chat",
      model: "qwen2.5-coder:7b",
      baseURL: "http://localhost:11434/v1",
    });
  });

  it("uses chat on explicit LLM_PROVIDER=chat", () => {
    const { info } = createProviderFromEnv({
      OPENAI_API_KEY: "k",
      LLM_PROVIDER: "chat",
      MODEL: "llama-3.3-70b-versatile",
    } as NodeJS.ProcessEnv);
    expect(info.kind).toBe("openai-chat");
  });

  it("explicit openai wins over baseURL", () => {
    const { info } = createProviderFromEnv({
      OPENAI_API_KEY: "k",
      LLM_PROVIDER: "openai",
      OPENAI_BASE_URL: "http://localhost:11434/v1",
    } as NodeJS.ProcessEnv);
    expect(info.kind).toBe("openai-responses");
  });
});
