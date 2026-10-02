/**
 * Thin-runtime behavioral flags (plan.md Phase 2 + Phase 4).
 *
 * The model stays the engineer. The runtime only refuses actions that are
 * obviously wasteful or destructive. Every flag defaults OFF so the default
 * tree matches the Phase 3 baseline (current agent + corrected harness).
 *
 * Groups (Phase 2, measured once each):
 * - hygiene: correctness fixes (searchIgnores, hideGitOutsideRepo,
 *   emptySuccess, shellHint, editRebase)
 * - economy: turn/token savers (editSnippet, readCache, skipSmallTodos)
 *
 * Behavioral flags (Phase 4, ablated one at a time):
 * - progressRedirect (A): same command twice with unchanged tree, or the
 *   same failure text with no successful write since -> block + evidence.
 * - apiLock (B): contract proposal rides on first plan/read turn; whole-file
 *   writes that drop package/exported signatures are rejected.
 * - contractTests (C): missing-test-file guidance, same-package temp test.
 * - stopOnGreen (D): stop when last targeted check is green.
 * - fastExplore (E): read-only turns may use settings.fast when it differs.
 */

export interface RuntimeFlags {
  hygiene: boolean;
  economy: boolean;
  progressRedirect: boolean;
  apiLock: boolean;
  contractTests: boolean;
  stopOnGreen: boolean;
  fastExplore: boolean;
}

export const DEFAULT_RUNTIME_FLAGS: RuntimeFlags = {
  hygiene: false,
  economy: false,
  progressRedirect: false,
  apiLock: false,
  contractTests: false,
  stopOnGreen: false,
  fastExplore: false,
};

/** Hygiene sub-pieces (unit-tested on/off individually, shipped as one group). */
export type HygienePiece =
  | "searchIgnores"
  | "hideGitOutsideRepo"
  | "emptySuccess"
  | "shellHint"
  | "editRebase";

/** Economy sub-pieces (unit-tested on/off individually, shipped as one group). */
export type EconomyPiece = "editSnippet" | "readCache" | "skipSmallTodos";

export function hygienePiecesEnabled(flags: RuntimeFlags): HygienePiece[] {
  return flags.hygiene
    ? ["searchIgnores", "hideGitOutsideRepo", "emptySuccess", "shellHint", "editRebase"]
    : [];
}

export function economyPiecesEnabled(flags: RuntimeFlags): EconomyPiece[] {
  return flags.economy ? ["editSnippet", "readCache", "skipSmallTodos"] : [];
}

export function isHygieneOn(flags: RuntimeFlags | undefined, piece: HygienePiece): boolean {
  if (!flags?.hygiene) return false;
  return hygienePiecesEnabled(flags).includes(piece);
}

export function isEconomyOn(flags: RuntimeFlags | undefined, piece: EconomyPiece): boolean {
  if (!flags?.economy) return false;
  return economyPiecesEnabled(flags).includes(piece);
}

/**
 * Parse a flag row from a comma/space-separated name list (EVAL_FLAGS).
 * Accepts full names (`hygiene`, `economy`, `progressRedirect`, `apiLock`,
 * `contractTests`, `stopOnGreen`, `fastExplore`) and single-letter aliases
 * A–E for the Phase 4 behavioral flags. Unknown names throw — a typo'd grid
 * must never silently run the flags-off baseline. Empty input = all off.
 */
export function parseFlagNames(raw: string): RuntimeFlags {
  const flags: RuntimeFlags = { ...DEFAULT_RUNTIME_FLAGS };
  const aliases: Record<string, keyof RuntimeFlags> = {
    hygiene: "hygiene",
    economy: "economy",
    progressredirect: "progressRedirect",
    a: "progressRedirect",
    apilock: "apiLock",
    b: "apiLock",
    contracttests: "contractTests",
    c: "contractTests",
    stopongreen: "stopOnGreen",
    d: "stopOnGreen",
    fastexplore: "fastExplore",
    e: "fastExplore",
  };
  for (const part of raw.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean)) {
    const key = aliases[part.toLowerCase()];
    if (!key) throw new Error(`Unknown runtime flag: ${JSON.stringify(part)} (expected hygiene, economy, A-E or full names)`);
    flags[key] = true;
  }
  return flags;
}

/** Parse flags from env (eval harness) without touching CLI defaults. */
export function runtimeFlagsFromEnv(env: NodeJS.ProcessEnv = process.env): RuntimeFlags {
  const on = (v: string | undefined): boolean => v === "1" || v?.toLowerCase() === "true";
  return {
    hygiene: on(env.CODEAGENT_HYGIENE),
    economy: on(env.CODEAGENT_ECONOMY),
    progressRedirect: on(env.CODEAGENT_PROGRESS_REDIRECT),
    apiLock: on(env.CODEAGENT_API_LOCK),
    contractTests: on(env.CODEAGENT_CONTRACT_TESTS),
    stopOnGreen: on(env.CODEAGENT_STOP_ON_GREEN),
    fastExplore: on(env.CODEAGENT_FAST_EXPLORE),
  };
}
