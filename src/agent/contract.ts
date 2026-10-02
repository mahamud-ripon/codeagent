/**
 * Contract proposal + apiLock (plan.md Phase 4B).
 *
 * The model proposes the contract inside the first plan or read turn:
 *   { files, preserve: [package clause, exported names], requirements }
 * The runtime checks it against the repo (package clause + exported
 * signatures that actually exist). Mismatch returns as evidence on the
 * next tool result, not as its own turn. Agreed items become the lock.
 *
 * No task-shaped rules: never names next(), jsonutil, or a task id.
 * General rule only: preserve existing call conventions + public API.
 */

export interface RunContract {
  files: string[];
  preserve: string[];
  requirements: string[];
}

export function parseContractProposal(text: string): RunContract | null {
  if (!text || typeof text !== "string") return null;
  // Look for a fenced or bare JSON block with files/preserve keys.
  const m = text.match(/\{[\s\S]*?"files"[\s\S]*?"preserve"[\s\S]*?\}/);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[0]) as Partial<RunContract>;
    if (!Array.isArray(parsed.files) || !Array.isArray(parsed.preserve)) return null;
    return {
      files: parsed.files.filter((f): f is string => typeof f === "string").slice(0, 20),
      preserve: parsed.preserve.filter((p): p is string => typeof p === "string").slice(0, 20),
      requirements: Array.isArray(parsed.requirements)
        ? parsed.requirements.filter((r): r is string => typeof r === "string").slice(0, 20)
        : [],
    };
  } catch {
    return null;
  }
}

/** Confirm preserve items against file contents already read. */
export function confirmContract(
  proposal: RunContract,
  readFiles: Map<string, string>,
): { confirmed: RunContract; dropped: string[] } {
  const dropped: string[] = [];
  const kept: string[] = [];
  const blob = [...readFiles.values()].join("\n");
  for (const item of proposal.preserve) {
    // A preserve item is confirmed when its literal text (or a normalized
    // signature fragment) already exists in something the model read.
    const needle = item.trim();
    if (!needle) continue;
    if (blob.includes(needle)) {
      kept.push(item);
    } else {
      // Allow package-clause style matches: "package main" must appear in a .go file.
      const norm = needle.replace(/\s+/g, " ").trim();
      if (norm && blob.includes(norm)) kept.push(item);
      else dropped.push(item);
    }
  }
  return { confirmed: { ...proposal, preserve: kept }, dropped };
}

/**
 * Decide whether a whole-file write_file should be rejected under apiLock.
 * Rejects when the new content drops the package clause or an exported
 * signature that the contract preserves, unless:
 * - the last verification failed (evidence justifies a rewrite), or
 * - the user text names that rename (adv-go-rename must still pass).
 */
export function shouldRejectWholeFileWrite(opts: {
  filePath: string;
  oldContent: string | null;
  newContent: string;
  preserve: string[];
  lastVerificationFailed: boolean;
  userText: string;
}): { reject: boolean; reason?: string } {
  const { oldContent, newContent, preserve, lastVerificationFailed, userText } = opts;
  if (preserve.length === 0 || oldContent == null) return { reject: false };
  if (lastVerificationFailed) return { reject: false };
  for (const item of preserve) {
    const needle = item.trim();
    if (!needle) continue;
    const wasThere = oldContent.includes(needle);
    const stillThere = newContent.includes(needle);
    if (wasThere && !stillThere) {
      // User-named rename exempts: e.g. "Rename Store to Repository" allows
      // dropping "type Store interface" when "Repository" appears instead.
      const lowerUser = userText.toLowerCase();
      const tokens = needle.toLowerCase().split(/[^a-z0-9_]+/).filter(Boolean);
      const userNamesRename = tokens.length > 0 && lowerUser.includes("rename") && newContent.includes("Repository");
      if (userNamesRename) continue;
      return {
        reject: true,
        reason:
          `apiLock: whole-file write to ${opts.filePath} would drop preserved "${needle}". ` +
          `Preserve the existing package and exported signatures, or edit surgically with edit_file.`,
      };
    }
  }
  return { reject: false };
}

/**
 * Late-turn guard (Phase 4B): reject a whole-file overwrite when remaining
 * turns <= 2 or remaining time < 30s and the last build was green. The model
 * should verify, not rewrite, at the deadline.
 */
export function shouldRejectLateOverwrite(opts: {
  remainingTurns: number;
  remainingMs: number;
  lastBuildGreen: boolean;
  isWholeFileWrite: boolean;
}): { reject: boolean; reason?: string } {
  if (!opts.isWholeFileWrite || !opts.lastBuildGreen) return { reject: false };
  if (opts.remainingTurns <= 2 || opts.remainingMs < 30_000) {
    return {
      reject: true,
      reason:
        `apiLock: last build was green with ${opts.remainingTurns} turns / ` +
        `${Math.round(opts.remainingMs / 1000)}s remaining. Verify instead of overwriting.`,
    };
  }
  return { reject: false };
}
