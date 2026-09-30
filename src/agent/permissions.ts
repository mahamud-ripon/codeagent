export interface PermissionRequest {
  type: "command" | "edit" | "read";
  target: string;
  details?: string;
  preview?: string;
}

export type PermissionHandler = (req: PermissionRequest) => Promise<boolean>;

export type PermissionMode = "default" | "acceptEdits" | "plan" | "bypass";

const MODE_CYCLE: PermissionMode[] = ["default", "acceptEdits", "plan", "bypass"];

/** SF-1 keyboard: Shift+Tab cycles default → acceptEdits → plan → bypass. */
export function cyclePermissionMode(current: PermissionMode): PermissionMode {
  const idx = MODE_CYCLE.indexOf(current);
  return MODE_CYCLE[(idx + 1) % MODE_CYCLE.length]!;
}

/** SF-6: network-egress commands need explicit confirm in default mode. */
const EGRESS_PATTERNS = [
  /\bssh\b/i,
  /\bscp\b/i,
  /\bcurl\b/i,
  /\bwget\b/i,
  /\bgit\s+push\b/i,
  /\bnpm\s+publish\b/i,
  /\bnpm\s+login\b/i,
  /\bgh\s+(auth|release|publish)\b/i,
  /\bdocker\s+push\b/i,
];

export function isNetworkEgressCommand(command: string): boolean {
  const segments = splitShellSegments(command);
  return segments.some((s) => EGRESS_PATTERNS.some((re) => re.test(s)));
}

export interface PermissionOptions {
  autoApprove?: boolean;
  handler?: PermissionHandler;
  mode?: PermissionMode;
  allow?: string[];
  deny?: string[];
  ask?: string[];
}

interface ParsedRule {
  tool: string;
  pattern: string;
}

/**
 * Split a shell command into segments that must each be authorized.
 * Respects quotes. Also surfaces command substitutions.
 */
export function splitShellSegments(command: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let depth = 0;

  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    const next = command[i + 1];
    if (quote) {
      current += c;
      if (c === quote && command[i - 1] !== "\\") quote = null;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      current += c;
      continue;
    }
    if (c === "(") depth++;
    if (c === ")") depth = Math.max(0, depth - 1);
    const double = (c === "&" && next === "&") || (c === "|" && next === "|");
    const single = c === ";" || (c === "|" && next !== "|") || (c === "&" && next !== "&");
    if (depth === 0 && (double || single)) {
      if (current.trim()) parts.push(current.trim());
      current = "";
      if (double) i++;
      continue;
    }
    current += c;
  }
  if (current.trim()) parts.push(current.trim());

  const subs: string[] = [];
  const re = /\$\(([^)]+)\)|`([^`]+)`/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(command)) !== null) {
    const inner = (match[1] ?? match[2] ?? "").trim();
    if (inner) subs.push(...splitShellSegments(inner).filter((s) => !s.includes("$(")));
  }
  return [...parts, ...subs];
}

export function parsePermissionRule(raw: string): ParsedRule | null {
  const match = raw.trim().match(/^([A-Za-z]+)\((.*)\)$/);
  if (!match) return null;
  return { tool: match[1]!, pattern: match[2]! };
}

function globToRegExp(pattern: string): RegExp {
  let source = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*");
  if (pattern.endsWith("/**")) {
    const base = pattern.slice(0, -3).replace(/[.+^${}()|[\]\\]/g, "\\$&");
    source = `${base}(?:/.*)?`;
  }
  return new RegExp(`^${source}$`, "i");
}

function matchPath(filePath: string, pattern: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  if (pattern === "**" || pattern === "*") return true;
  return globToRegExp(pattern).test(normalized);
}

function matchBash(command: string, pattern: string): boolean {
  const cmd = command.trim();
  const lower = cmd.toLowerCase();
  if (pattern.endsWith(":*")) {
    const prefix = pattern.slice(0, -2).trim().toLowerCase();
    return lower === prefix || lower.startsWith(prefix + " ");
  }
  if (pattern.endsWith("*") && !pattern.includes("/")) {
    return lower.startsWith(pattern.slice(0, -1).trim().toLowerCase());
  }
  return lower === pattern.trim().toLowerCase();
}

function isHardDenied(segment: string): boolean {
  const cmd = segment.trim();
  if (/^(sudo|doas)\b/i.test(cmd)) return true;
  if (/^rm\s+(-[^\s]*r[^\s]*|--recursive)\s+\/(\s|$)/i.test(cmd)) return true;
  if (/^rm\s+-rf\s+\/(\s|$)/i.test(cmd)) return true;
  if (/^(mkfs|shutdown|reboot|halt|diskpart)\b/i.test(cmd)) return true;
  if (/:\(\)\s*\{/.test(cmd)) return true;
  if (/^format\s+[a-z]:/i.test(cmd)) return true;
  return false;
}

export class PermissionManager {
  private allowedCommandPrefixes: Set<string> = new Set();
  private sessionExact = new Set<string>();
  private allowRules: ParsedRule[] = [];
  private denyRules: ParsedRule[] = [];
  private askRules: ParsedRule[] = [];
  private autoApprove: boolean;
  private mode: PermissionMode;
  private handler?: PermissionHandler;

  constructor(options?: PermissionOptions) {
    this.autoApprove = options?.autoApprove ?? false;
    this.mode = options?.mode ?? (this.autoApprove ? "bypass" : "default");
    if (this.mode === "bypass") this.autoApprove = true;
    this.handler = options?.handler;
    for (const rule of options?.allow ?? []) this.addRule("allow", rule);
    for (const rule of options?.deny ?? []) this.addRule("deny", rule);
    for (const rule of options?.ask ?? []) this.addRule("ask", rule);
  }

  getMode(): PermissionMode {
    return this.mode;
  }

  /** Store a full command, never a bare first token. */
  allowCommand(command: string): void {
    const trimmed = command.trim();
    if (trimmed) this.sessionExact.add(trimmed);
  }

  allowRule(rule: string): void {
    this.addRule("allow", rule);
  }

  allowPrefix(prefix: string): void {
    const trimmed = prefix.trim().toLowerCase();
    if (trimmed) this.allowedCommandPrefixes.add(trimmed);
  }

  isAutoApprove(): boolean {
    return this.autoApprove || this.mode === "bypass";
  }

  setAutoApprove(value: boolean): void {
    this.autoApprove = value;
    if (value) this.mode = "bypass";
    else if (this.mode === "bypass") this.mode = "default";
  }

  /** SF-1 keyboard handler helper: advance mode and sync autoApprove. */
  cycleMode(): PermissionMode {
    this.mode = cyclePermissionMode(this.mode);
    this.autoApprove = this.mode === "bypass";
    return this.mode;
  }

  setMode(mode: PermissionMode): void {
    this.mode = mode;
    this.autoApprove = mode === "bypass";
  }

  private addRule(bucket: "allow" | "deny" | "ask", raw: string): void {
    const parsed = parsePermissionRule(raw);
    if (!parsed) return;
    const list = bucket === "allow" ? this.allowRules : bucket === "deny" ? this.denyRules : this.askRules;
    list.push(parsed);
  }

  private matches(rules: ParsedRule[], tool: string, target: string): boolean {
    return rules.some((rule) => {
      if (rule.tool.toLowerCase() !== tool.toLowerCase()) return false;
      if (tool.toLowerCase() === "bash") return matchBash(target, rule.pattern);
      return matchPath(target, rule.pattern);
    });
  }

  private segmentAllowed(segment: string): boolean {
    const trimmed = segment.trim();
    const lower = trimmed.toLowerCase();
    if (this.sessionExact.has(trimmed)) return true;
    for (const prefix of this.allowedCommandPrefixes) {
      if (lower === prefix || lower.startsWith(prefix + " ")) return true;
    }
    return this.matches(this.allowRules, "Bash", trimmed);
  }

  isCommandAllowed(command: string): boolean {
    if (this.isAutoApprove()) return true;
    const segments = splitShellSegments(command);
    if (segments.length === 0) return false;
    return segments.every((segment) => this.segmentAllowed(segment));
  }

  /** Exact session allow (allowCommand full string): never re-asks, even for egress. */
  hasExactAllow(command: string): boolean {
    return this.sessionExact.has(command.trim());
  }

  async checkCommand(command: string): Promise<boolean> {
    const segments = splitShellSegments(command);
    if (!this.isAutoApprove() && segments.some(isHardDenied)) return false;
    if (!this.isAutoApprove() && (this.matches(this.denyRules, "Bash", command) || segments.some((s) => this.matches(this.denyRules, "Bash", s)))) {
      return false;
    }
    if (this.isAutoApprove()) return true;
    // SF-6: network-egress commands confirm in default mode. An exact
    // session allow ("Always allow this exact command") stays silent so
    // allowCommand("git push") still permits "git push" handler-free.
    if (this.mode === "default" && isNetworkEgressCommand(command)) {
      if (this.hasExactAllow(command)) return true;
      const covered = segments.every((s) => this.segmentAllowed(s));
      if (!covered && !this.handler) return false;
      if (this.handler) return this.handler({ type: "command", target: command, details: "network-egress" });
      return false;
    }
    const needsAsk = this.matches(this.askRules, "Bash", command) || segments.some((s) => this.matches(this.askRules, "Bash", s));
    if (!needsAsk && this.isCommandAllowed(command)) return true;
    if (!this.handler) return false;
    return this.handler({ type: "command", target: command });
  }

  /**
   * Gate writes and edits. Fail closed when nobody is available to ask.
   * Deny rules win over acceptEdits. Bypass skips the ask.
   */
  async checkEdit(filePath: string, details?: string): Promise<boolean> {
    if (this.isAutoApprove()) return true;
    if (this.matches(this.denyRules, "Edit", filePath) || this.matches(this.denyRules, "Write", filePath)) {
      return false;
    }
    if (this.mode === "plan") return false;
    if (this.mode === "acceptEdits") return true;
    if (this.matches(this.allowRules, "Edit", filePath) || this.matches(this.allowRules, "Write", filePath)) {
      return true;
    }
    if (!this.handler) return false;
    return this.handler({ type: "edit", target: filePath, details, preview: details });
  }

  checkRead(filePath: string): boolean {
    if (this.isAutoApprove()) return true;
    if (this.matches(this.denyRules, "Read", filePath)) return false;
    return true;
  }
}
