export type AgentIntent = "conversational" | "inquiry" | "task" | "external";

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

/** Questions about the agent itself — answer from system prompt, no repo reads. */
const SELF_PATTERNS = [
  /\bwhat\s+is\s+codeagent\b/i,
  /\bwho\s+(made|built|created)\s+(you|codeagent)\b/i,
  /\bhow\s+do\s+(you|codeagent)\s+work\b/i,
];

/**
 * Current/external information request — needs web_search capability.
 * e.g. "which is latest claude model", "today's price", "current docs".
 */
const CURRENT_INFO_PATTERNS = [
  /\b(latest|newest|current|today'?s?|right\s+now|as\s+of|up[\s-]?to[\s-]?date)\b/i,
  /\b20(2[6-9]|[3-9]\d)\b/,
  /\b(search\s+(the\s+)?web|search\s+for|look\s*up|google\s+(for|it)|web\s+search)\b/i,
  /\bwhat('s| is) the latest\b/i,
  /\bwhich is (the )?(latest|newest|current)\b/i,
  /\b(newest|latest)\s+(version|release|model|docs|documentation)\b/i,
  /\b(current\s+)?(price|version|release|changelog|docs|documentation)\b.*\?$/i,
];

/**
 * Repo-specific signals — distinguishes "where is App defined HERE"
 * from general "what is github?". Inquiry requires at least one of these
 * (or an INQUIRY_PATTERN with repo context); otherwise general knowledge
 * stays conversational with zero tools.
 */
const REPO_SIGNALS = /\b(here|repo|repository|project|codebase|layout|structure|this\s+(repo|repository|project|codebase|code|app|file|folder|directory)|our\s+(repo|project|codebase|code|app)|project\s+structure|codebase|in\s+(this|the)\s+(repo|project|code)|file|folder|directory|function|component|class|module|auth\w*|rout\w+|middleware|import|export|package\.json|TS|API\s+route)\b/i;

const GENERAL_KNOWLEDGE_PATTERNS = [
  /^(what\s+is|what'?s|what\s+are|who\s+is|define|explain\s+(how\s+)?(a\s+|the\s+)?(general|concept)?)\b/i,
  /^(explain|describe|tell\s+me\s+about)\s+(recursion|github|git|docker|rest|http|json|python|javascript|typescript|react|node|general|concept)/i,
];

const ACTION_VERBS = /\b(fix|add|create|implement|modify|edit|update|change|delete|remove|refactor|build|test|lint|typecheck|run|rewrite|replace|install|upgrade|commit)\b/i;
const CODE_FILE_EXTENSION = /\b[\w-]+\.(ts|tsx|js|jsx|json|html|css|scss|md|py|go|rs|java|c|cpp|h|yml|yaml|toml|sh)\b/i;

/**
 * Classifies a user prompt into:
 * - "conversational": Pure dialogue, greetings, general knowledge, or
 *   open-ended help queries (0 tool executions, no repo context).
 * - "inquiry": Repo-specific information seeking (read-only exploration).
 * - "task": Direct code modification, debugging, or execution.
 * - "external": Current/external information needing web_search capability.
 *   No repo context; explicit limitation when web is unavailable.
 */
export function isCurrentInfoQuery(prompt: string): boolean {
  const t = prompt.trim();
  for (const p of CURRENT_INFO_PATTERNS) {
    if (p.test(t)) return true;
  }
  return false;
}

/** True for exact greetings/thanks that can skip the LLM entirely. */
export function isExactGreeting(prompt: string): boolean {
  const t = prompt.trim().toLowerCase().replace(/[!.,?]+$/, "");
  return /^(hi|hello|hey|yo|howdy|sup|greetings)(\s+there)?$/.test(t)
    || /^(good\s+(morning|afternoon|evening|day))$/.test(t)
    || /^(thanks|thank you|thx|cheers)(\s+a\s+lot|\s+very\s+much)?$/.test(t)
    || /^(bye|goodbye|see ya)$/.test(t);
}

/** Canned instant reply for exact greetings — no model call, ~0ms. */
export function fastGreetingResponse(prompt: string): string | null {
  const t = prompt.trim().toLowerCase().replace(/[!.,?]+$/, "");
  if (/^(hi|hello|hey|yo|howdy|sup|greetings)(\s+there)?$/.test(t)) {
    return "Hello! What would you like to work on?";
  }
  if (/^(good\s+(morning|afternoon|evening|day))$/.test(t)) {
    return "Hello! What would you like to work on?";
  }
  if (/^(thanks|thank you|thx|cheers)(\s+a\s+lot|\s+very\s+much)?$/.test(t)) {
    return "You're welcome! Anything else I can help with?";
  }
  if (/^(bye|goodbye|see ya)$/.test(t)) {
    return "Bye!";
  }
  return null;
}

export function classifyIntent(prompt: string, previousIntent?: AgentIntent): AgentIntent {
  const trimmed = prompt.trim();
  if (!trimmed) return "conversational";

  // Check if it's explicitly conversational
  for (const pattern of CONVERSATIONAL_STANDALONE) {
    if (pattern.test(trimmed)) {
      return "conversational";
    }
  }

  // Recognize the subject even when a short dialogue request has a typo.
  // Explicit file/code actions must still reach the task path.
  if (!ACTION_VERBS.test(trimmed) && !CODE_FILE_EXTENSION.test(trimmed) &&
      /\b(our|this)\s+(con?versation|chat|discussion|dialogue)\b/i.test(trimmed)) {
    return "conversational";
  }

  // Check if it's a meta-question about the conversation/chat history itself
  for (const pattern of META_CONVERSATIONAL_PATTERNS) {
    if (pattern.test(trimmed)) {
      return "conversational";
    }
  }

  // Agent-self questions — no repo reads needed
  for (const pattern of SELF_PATTERNS) {
    if (pattern.test(trimmed)) {
      return "conversational";
    }
  }

  // If it mentions specific action verbs or filenames, it's a task even if phrased politely
  // e.g. "can you help me fix App.tsx?" -> task
  // Note: "search the web" is NOT a code action — handled as external below.
  const hasActionVerb = ACTION_VERBS.test(trimmed);
  const mentionsFile = CODE_FILE_EXTENSION.test(trimmed);

  if (hasActionVerb || mentionsFile) {
    return "task";
  }

  // Current/external info needs web capability — before inquiry so
  // "which is latest claude model" doesn't become a repo task.
  if (isCurrentInfoQuery(trimmed)) {
    return "external";
  }

  const hasRepoSignal = REPO_SIGNALS.test(trimmed);

  // Check for informational inquiry — repo-scoped only. A bare
  // "explain recursion" or "what is github?" without repo signals is
  // general knowledge -> conversational (zero tools).
  for (const pattern of INQUIRY_PATTERNS) {
    if (pattern.test(trimmed)) {
      if (hasRepoSignal) return "inquiry";
      // "explain X" with no repo signal: repo only if X looks like
      // project internals, else general knowledge.
      if (/^(explain|describe|summarize|tell\s+me\s+about)\b/i.test(trimmed)) {
        return hasRepoSignal ? "inquiry" : "conversational";
      }
      return "inquiry";
    }
  }

  // General-knowledge questions without repo signals -> conversational
  for (const pattern of GENERAL_KNOWLEDGE_PATTERNS) {
    if (pattern.test(trimmed) && !hasRepoSignal) {
      return "conversational";
    }
  }

  // Short questions: repo signal -> inquiry, else conversational.
  // (Was: always inquiry — caused 40-60s repo loads for "what is github?")
  if (trimmed.endsWith("?") && trimmed.split(/\s+/).length < 10) {
    return hasRepoSignal ? "inquiry" : "conversational";
  }

  // Ambiguous follow-ups inherit the previous topic. Explicit actions, files,
  // repository questions and current-info requests above always take priority.
  if (hasRepoSignal) return "inquiry";
  return previousIntent ?? "task";
}
