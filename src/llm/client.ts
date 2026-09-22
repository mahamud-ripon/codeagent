import OpenAI from "openai";

/**
 * Thin wrapper: env validation + client construction.
 * The agent loop lives in agent/agent.ts and takes an injected
 * responder so tests can run without network access.
 */
export function getApiKey(): string {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    throw new Error(
      "OPENAI_API_KEY is not set. Copy .env.example to .env and add your key.",
    );
  }
  return key;
}

export function createOpenAIClient(apiKey?: string): OpenAI {
  return new OpenAI({ apiKey: apiKey ?? getApiKey() });
}

/** Minimal shape of what the agent needs from client.responses.create. */
export interface ResponsesCreateResult {
  output: Array<{
    type: string;
    call_id?: string;
    name?: string;
    arguments?: string;
    /** Assistant text for provider-returned message items. */
    content?: string;
  }>;
  output_text: string;
}

export type Responder = (input: unknown[]) => Promise<ResponsesCreateResult>;

export function createResponder(
  client: OpenAI,
  args: { model: string; instructions: string },
): Responder {
  return async (input: unknown[]) => {
    const { tools } = await import("./tools.js");
    const response = await client.responses.create({
      model: args.model,
      instructions: args.instructions,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tools: tools as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      input: input as any,
    });
    return {
      output: response.output.map((item) => ({
        type: (item as { type: string }).type,
        call_id: (item as { call_id?: string }).call_id,
        name: (item as { name?: string }).name,
        arguments: (item as { arguments?: string }).arguments,
      })),
      output_text: response.output_text,
    };
  };
}
