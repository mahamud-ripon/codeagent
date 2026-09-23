export type AgentIntent = "conversational" | "inquiry" | "task";

const CONVERSATIONAL_STANDALONE = [
  /^(hi|hello|hey|yo|howdy|sup|greetings)(\s+there|\s+codeagent|\s+assistant|\s+bot)?[\s.!,?]*$/i,
  /^(good\s+(morning|afternoon|evening|day))[\s.!,?]*$/i,
  /^(thanks(\s+a\s+lot)?|thank\s+you(\s+very\s+much)?|thx|cheers|awesome|great|cool|ok|okay|nice|perfect|got\s+it)(,\s*(thanks|thank\s+you|cool|ok|okay))?[\s.!,?]*$/i,
  /^(cool|ok|okay|nice|awesome),\s*(thanks|thank\s+you)[\s.!,?]*$/i,
  /^(who\s+are\s+you|what\s+are\s+you|what\s+is\s+your\s+name)[\s.!,?]*$/i,
  /^(can\s+you\s+help(\s+me)?(\s+with\s+(something|a\s+task|code))?|could\s+you\s+help\s+me|help\s+me|are\s+you\s+(there|ready|available))[\s.!,?]*$/i,
  /^(what\s+can\s+you\s+do|what\s+are\s+your\s+capabilities|how\s+do\s+i\s+use\s+(you|this))[\s.!,?]*$/i,
  /^(bye|goodbye|see\s+ya|exit|quit)[\s.!,?]*$/i,
];

const META_CONVERSATIONAL_PATTERNS = [
  /\b(in\s+our\s+(conversation|chat|dialogue|history)|in\s+this\s+(conversation|chat)|from\s+our\s+chat)\b/i,
  /\b(conversation\s+history|chat\s+history|our\s+previous\s+(discussion|talk|messages?))\b/i,
  /\bwhat\s+did\s+(we|i)\s+(talk|discuss|say|ask)\b/i,
  /\bdid\s+(we|i)\s+(talk|discuss|mention|ask)\s+about\b/i,
  /\bsummarize\s+(our\s+)?(conversation|chat|discussion)\b/i,
  /\bcan\s+you\s+see\s+(our\s+)?(conversation|chat)\s+history\b/i,
  /\bdo\s+you\s+remember\s+(what|our|when)\b/i,
];

const INQUIRY_PATTERNS = [
  /^(where\s+(is|are)|how\s+(does|do|can)|what\s+does|why\s+does|which\s+file|show\s+me\s+where|find\s+where)\b/i,
  /^(explain|describe|summarize|tell\s+me\s+about)\b/i,
  /\bhow\s+is\s+\w+\s+implemented\b/i,
];

const ACTION_VERBS = /\b(fix|add|create|implement|modify|edit|update|change|delete|remove|refactor|build|test|lint|typecheck|run|rewrite|replace|install|upgrade|commit)\b/i;
const CODE_FILE_EXTENSION = /\b[\w-]+\.(ts|tsx|js|jsx|json|html|css|scss|md|py|go|rs|java|c|cpp|h|yml|yaml|toml|sh)\b/i;

/**
 * Classifies a user prompt into:
 * - "conversational": Pure dialogue, greetings, or open-ended help queries (0 tool executions).
 * - "inquiry": Information seeking / codebase questions (read-only exploration).
 * - "task": Direct code modification, debugging, or execution.
 */
export function classifyIntent(prompt: string): AgentIntent {
  const trimmed = prompt.trim();
  if (!trimmed) return "conversational";

  // Check if it's explicitly conversational
  for (const pattern of CONVERSATIONAL_STANDALONE) {
    if (pattern.test(trimmed)) {
      return "conversational";
    }
  }

  // Check if it's a meta-question about the conversation/chat history itself
  for (const pattern of META_CONVERSATIONAL_PATTERNS) {
    if (pattern.test(trimmed)) {
      return "conversational";
    }
  }

  // If it mentions specific action verbs or filenames, it's a task even if phrased politely
  // e.g. "can you help me fix App.tsx?" -> task
  const hasActionVerb = ACTION_VERBS.test(trimmed);
  const mentionsFile = CODE_FILE_EXTENSION.test(trimmed);

  if (hasActionVerb || mentionsFile) {
    return "task";
  }

  // Check for informational inquiry
  for (const pattern of INQUIRY_PATTERNS) {
    if (pattern.test(trimmed)) {
      return "inquiry";
    }
  }

  // Default: if it ends with a question mark and is short, treat as inquiry / conversational
  if (trimmed.endsWith("?") && trimmed.split(/\s+/).length < 10) {
    return "inquiry";
  }

  // Otherwise assume it's a task instruction
  return "task";
}
