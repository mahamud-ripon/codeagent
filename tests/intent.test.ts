import { describe, expect, it } from "vitest";
import { classifyIntent } from "../src/agent/intent.js";

describe("classifyIntent", () => {
  it("classifies greetings and polite remarks as conversational", () => {
    expect(classifyIntent("hello")).toBe("conversational");
    expect(classifyIntent("hi there")).toBe("conversational");
    expect(classifyIntent("good morning")).toBe("conversational");
    expect(classifyIntent("thanks!")).toBe("conversational");
    expect(classifyIntent("cool, thank you")).toBe("conversational");
    expect(classifyIntent("ok")).toBe("conversational");
  });

  it("classifies open-ended help queries without tasks as conversational", () => {
    expect(classifyIntent("can you help me?")).toBe("conversational");
    expect(classifyIntent("can you help me with something?")).toBe("conversational");
    expect(classifyIntent("what can you do?")).toBe("conversational");
    expect(classifyIntent("who are you?")).toBe("conversational");
    expect(classifyIntent("are you ready?")).toBe("conversational");
  });

  it("classifies polite requests with concrete tasks as tasks", () => {
    expect(classifyIntent("can you help me fix App.tsx?")).toBe("task");
    expect(classifyIntent("please fix the add function in math.ts")).toBe("task");
    expect(classifyIntent("can you run the test suite?")).toBe("task");
    expect(classifyIntent("add a button component")).toBe("task");
  });

  it("classifies code modification and commands as tasks", () => {
    expect(classifyIntent("fix the bug in math.ts")).toBe("task");
    expect(classifyIntent("create a new file called logger.ts")).toBe("task");
    expect(classifyIntent("refactor the auth provider")).toBe("task");
    expect(classifyIntent("run npm test")).toBe("task");
  });

  it("classifies codebase questions as inquiries", () => {
    expect(classifyIntent("where is the App component defined?")).toBe("inquiry");
    expect(classifyIntent("how does authentication work here?")).toBe("inquiry");
    expect(classifyIntent("explain the project structure")).toBe("inquiry");
    expect(classifyIntent("which file handles routing?")).toBe("inquiry");
  });

  it("classifies questions about the conversation history as conversational", () => {
    expect(classifyIntent("Query where was Context-aware code search in our conversation?")).toBe("conversational");
    expect(classifyIntent("can you see our conversation history?")).toBe("conversational");
    expect(classifyIntent("what did we discuss earlier?")).toBe("conversational");
    expect(classifyIntent("summarize our conversation")).toBe("conversational");
  });
});

