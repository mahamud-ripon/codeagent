export type AgentPhase = "explore" | "implement" | "verify" | "review" | "done";

export interface AgentConfig {
  repoRoot: string;
  model: string;
  maxIterations: number;
}

export interface ToolCallRecord {
  iteration: number;
  name: string;
  args: Record<string, unknown>;
  success: boolean;
  /** First ~200 chars, for loop detection + logs. */
  summary: string;
}

export interface TestRecord {
  command: string;
  exitCode: number;
  /** Truncated tail shown to the model / user. */
  outputPreview: string;
}

export interface AgentState {
  userRequest: string;
  iteration: number;
  phase: AgentPhase;
  relevantFiles: Set<string>;
  modifiedFiles: Set<string>;
  recentSignatures: string[];
  toolCalls: ToolCallRecord[];
  testResults: TestRecord[];
  errors: string[];
}

export type AgentIntent = "conversational" | "inquiry" | "task";

export interface AgentRunResult {
  finalMessage: string;
  iterations: number;
  modifiedFiles: string[];
  testResults: TestRecord[];
  history?: unknown[];
  intent?: AgentIntent;
}

export function createInitialState(userRequest: string): AgentState {
  return {
    userRequest,
    iteration: 0,
    phase: "explore",
    relevantFiles: new Set(),
    modifiedFiles: new Set(),
    recentSignatures: [],
    toolCalls: [],
    testResults: [],
    errors: [],
  };
}

/** Heuristic phase inference — no state-machine framework needed. */
export function inferPhase(state: AgentState): AgentPhase {
  if (state.testResults.length > 0) return "verify";
  if (state.modifiedFiles.size > 0) return "implement";
  if (state.iteration >= 2) return "implement";
  return "explore";
}
