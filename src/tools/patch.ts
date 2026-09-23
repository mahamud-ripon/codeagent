/**
 * Resilient multi-strategy patching engine for Codeagent Level 3.
 *
 * Strategies:
 * 1. Exact Substring Match
 * 2. CRLF / LF Normalized Match
 * 3. Trimmed & Indentation-Tolerant Line Match
 * 4. Fuzzy Similarity Match (Levenshtein / Dice Coefficient on sliding window)
 * 5. Unified Diff Hunk Application
 */

export interface PatchResult {
  updated: string;
  strategy: "exact" | "crlf_normalized" | "trimmed_lines" | "fuzzy_similarity" | "unified_diff";
}

/** Compute Dice's coefficient (bigram similarity) between two strings in [0, 1]. */
export function stringSimilarity(a: string, b: string): number {
  const s1 = a.trim();
  const s2 = b.trim();
  if (s1 === s2) return 1.0;
  if (s1.length < 2 || s2.length < 2) return s1.toLowerCase() === s2.toLowerCase() ? 1.0 : 0.0;

  const bigrams = new Map<string, number>();
  for (let i = 0; i < s1.length - 1; i++) {
    const bigram = s1.substring(i, i + 2);
    bigrams.set(bigram, (bigrams.get(bigram) ?? 0) + 1);
  }

  let intersection = 0;
  for (let i = 0; i < s2.length - 1; i++) {
    const bigram = s2.substring(i, i + 2);
    const count = bigrams.get(bigram) ?? 0;
    if (count > 0) {
      bigrams.set(bigram, count - 1);
      intersection++;
    }
  }

  return (2.0 * intersection) / (s1.length - 1 + (s2.length - 1));
}

/** Check if text looks like a unified diff. */
export function isUnifiedDiff(text: string): boolean {
  return /^@@\s+-\d+,\d+\s+\+\d+,\d+\s+@@/m.test(text) ||
    (/^---/m.test(text) && /^\+\+\+/m.test(text) && /^@@/m.test(text));
}

/** Apply a simple unified diff hunk to target text. */
export function applyUnifiedDiff(content: string, diffText: string): string {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const diffLines = diffText.replace(/\r\n/g, "\n").split("\n");

  let i = 0;
  while (i < diffLines.length) {
    const line = diffLines[i];
    const hunkHeader = line.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/);
    if (hunkHeader) {
      const origStart = parseInt(hunkHeader[1], 10) - 1;
      i++;

      const oldHunkLines: string[] = [];
      const newHunkLines: string[] = [];

      while (i < diffLines.length && !diffLines[i].startsWith("@@")) {
        const dLine = diffLines[i];
        if (dLine.startsWith("-")) {
          oldHunkLines.push(dLine.slice(1));
        } else if (dLine.startsWith("+")) {
          newHunkLines.push(dLine.slice(1));
        } else if (dLine.startsWith(" ") || dLine === "") {
          oldHunkLines.push(dLine.slice(1));
          newHunkLines.push(dLine.slice(1));
        }
        i++;
      }

      // Try exact line placement from header
      let matchIdx = -1;
      if (origStart >= 0 && origStart + oldHunkLines.length <= lines.length) {
        let exactMatch = true;
        for (let k = 0; k < oldHunkLines.length; k++) {
          if (lines[origStart + k] !== oldHunkLines[k]) {
            exactMatch = false;
            break;
          }
        }
        if (exactMatch) matchIdx = origStart;
      }

      // Fallback: search anywhere in file
      if (matchIdx === -1 && oldHunkLines.length > 0) {
        for (let k = 0; k <= lines.length - oldHunkLines.length; k++) {
          let matches = true;
          for (let m = 0; m < oldHunkLines.length; m++) {
            if (lines[k + m].trim() !== oldHunkLines[m].trim()) {
              matches = false;
              break;
            }
          }
          if (matches) {
            matchIdx = k;
            break;
          }
        }
      }

      if (matchIdx !== -1) {
        lines.splice(matchIdx, oldHunkLines.length, ...newHunkLines);
      } else {
        throw new Error("Could not apply unified diff: hunk context lines not found in file.");
      }
    } else {
      i++;
    }
  }

  return lines.join("\n");
}

/** Pre-flight syntax validation before writing to disk. */
export function validateSyntaxPreFlight(content: string, filePath?: string): void {
  if (!filePath) return;
  const ext = filePath.split(".").pop()?.toLowerCase();

  if (ext === "json") {
    try {
      JSON.parse(content);
    } catch (err) {
      throw new Error(`Pre-flight JSON syntax validation failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else if (ext === "ts" || ext === "tsx" || ext === "js" || ext === "jsx") {
    // Quick bracket & quote parity check ignoring strings & comments
    const stack: { char: string; line: number }[] = [];
    const lines = content.split("\n");
    let inBlockComment = false;

    for (let lineNum = 1; lineNum <= lines.length; lineNum++) {
      const line = lines[lineNum - 1];
      let inString: string | null = null;
      let escape = false;

      for (let c = 0; c < line.length; c++) {
        const char = line[c];
        const nextChar = line[c + 1];

        if (inBlockComment) {
          if (char === "*" && nextChar === "/") {
            inBlockComment = false;
            c++;
          }
          continue;
        }

        if (!inString && char === "/" && nextChar === "*") {
          inBlockComment = true;
          c++;
          continue;
        }

        if (!inString && char === "/" && nextChar === "/") {
          // Line comment -> rest of line ignored
          break;
        }

        if (inString) {
          if (escape) {
            escape = false;
          } else if (char === "\\") {
            escape = true;
          } else if (char === inString) {
            inString = null;
          }
          continue;
        }

        if (char === "'" || char === '"' || char === "`") {
          inString = char;
          continue;
        }

        if (char === "{" || char === "(" || char === "[") {
          stack.push({ char, line: lineNum });
        } else if (char === "}" || char === ")" || char === "]") {
          const expected = char === "}" ? "{" : char === ")" ? "(" : "[";
          if (stack.length === 0 || stack[stack.length - 1].char !== expected) {
            throw new Error(
              `Pre-flight syntax error on line ${lineNum}: unexpected closing '${char}' (no matching opening '${expected}').`,
            );
          }
          stack.pop();
        }
      }
    }

    if (stack.length > 0) {
      const unclosed = stack[stack.length - 1];
      throw new Error(
        `Pre-flight syntax error: unclosed '${unclosed.char}' opened on line ${unclosed.line}.`,
      );
    }
  }
}

/**
 * Apply resilient multi-strategy patch to content.
 */
export function applyMultiStrategyPatch(
  content: string,
  oldText: string,
  newText: string,
  filePath?: string,
): PatchResult {
  if (!oldText && !isUnifiedDiff(newText)) {
    throw new Error("old_text must be non-empty");
  }

  const isCRLF = content.includes("\r\n");

  // Strategy 0: Unified Diff check
  if (isUnifiedDiff(oldText) || isUnifiedDiff(newText)) {
    const diffToApply = isUnifiedDiff(oldText) ? oldText : newText;
    const patched = applyUnifiedDiff(content, diffToApply);
    const finalContent = isCRLF ? patched.replace(/\n/g, "\r\n") : patched;
    validateSyntaxPreFlight(finalContent, filePath);
    return { updated: finalContent, strategy: "unified_diff" };
  }

  // Strategy 1: Exact substring match
  const occurrences = content.split(oldText).length - 1;
  if (occurrences === 1) {
    const updated = content.replace(oldText, newText);
    validateSyntaxPreFlight(updated, filePath);
    return { updated, strategy: "exact" };
  }
  if (occurrences > 1) {
    throw new Error(
      `old_text matched ${occurrences} times. Provide a longer, more specific snippet so the edit is unambiguous.`,
    );
  }

  // Strategy 2: Line-ending normalized match (\r\n vs \n)
  const normContent = content.replace(/\r\n/g, "\n");
  const normOld = oldText.replace(/\r\n/g, "\n");
  const normNew = newText.replace(/\r\n/g, "\n");
  const normOccurrences = normContent.split(normOld).length - 1;

  if (normOccurrences === 1) {
    const updatedNorm = normContent.replace(normOld, normNew);
    const updated = isCRLF ? updatedNorm.replace(/\n/g, "\r\n") : updatedNorm;
    validateSyntaxPreFlight(updated, filePath);
    return { updated, strategy: "crlf_normalized" };
  }
  if (normOccurrences > 1) {
    throw new Error(
      `old_text matched ${normOccurrences} times. Provide a longer, more specific snippet so the edit is unambiguous.`,
    );
  }

  // Strategy 3: Trimmed & Indentation-tolerant line-by-line match
  const contentLines = normContent.split("\n");
  const oldLines = normOld.split("\n");

  if (oldLines.length > 0 && oldLines.length <= contentLines.length) {
    const matchingIndices: number[] = [];
    for (let i = 0; i <= contentLines.length - oldLines.length; i++) {
      let matches = true;
      for (let j = 0; j < oldLines.length; j++) {
        if (contentLines[i + j].trim() !== oldLines[j].trim()) {
          matches = false;
          break;
        }
      }
      if (matches) {
        matchingIndices.push(i);
      }
    }

    if (matchingIndices.length === 1) {
      const startIdx = matchingIndices[0];
      const newLines = normNew.split("\n");

      // Adapt indentation of newLines to match the indentation of the target file
      const targetBaseIndent = contentLines[startIdx].match(/^(\s*)/)?.[1] ?? "";
      const snippetBaseIndent = oldLines[0].match(/^(\s*)/)?.[1] ?? "";

      // Check if there is an indent step difference between snippet and target
      let targetStep = 0;
      let snippetStep = 0;
      for (let j = 1; j < oldLines.length; j++) {
        const sIndent = (oldLines[j].match(/^(\s*)/)?.[1] ?? "").length - snippetBaseIndent.length;
        const tIndent = (contentLines[startIdx + j].match(/^(\s*)/)?.[1] ?? "").length - targetBaseIndent.length;
        if (sIndent > 0 && tIndent > 0) {
          snippetStep = sIndent;
          targetStep = tIndent;
          break;
        }
      }

      const scale = snippetStep > 0 && targetStep > 0 ? targetStep / snippetStep : 1;

      const adaptedNewLines = newLines.map((line) => {
        if (!line.trim()) return "";
        const currentIndentLen = (line.match(/^(\s*)/)?.[1] ?? "").length;
        const relIndent = Math.max(0, currentIndentLen - snippetBaseIndent.length);
        const targetIndentLen = targetBaseIndent.length + Math.round(relIndent * scale);
        const indentStr = " ".repeat(targetIndentLen);
        return indentStr + line.trimStart();
      });

      contentLines.splice(startIdx, oldLines.length, ...adaptedNewLines);
      const updatedNorm = contentLines.join("\n");
      const updated = isCRLF ? updatedNorm.replace(/\n/g, "\r\n") : updatedNorm;
      validateSyntaxPreFlight(updated, filePath);
      return { updated, strategy: "trimmed_lines" };
    }
    if (matchingIndices.length > 1) {
      throw new Error(
        `old_text matched ${matchingIndices.length} times when ignoring whitespace. Provide a longer snippet so the edit is unambiguous.`,
      );
    }
  }

  // Strategy 4: Fuzzy Sliding Window Match (Dice similarity on multiline block)
  if (oldLines.length >= 2 && oldLines.length <= contentLines.length) {
    let bestScore = 0;
    let bestIdx = -1;
    let secondBestScore = 0;

    const oldJoined = oldLines.map((l) => l.trim()).join("\n");

    for (let i = 0; i <= contentLines.length - oldLines.length; i++) {
      const candidateLines = contentLines.slice(i, i + oldLines.length);
      const candidateJoined = candidateLines.map((l) => l.trim()).join("\n");
      const score = stringSimilarity(candidateJoined, oldJoined);

      if (score > bestScore) {
        secondBestScore = bestScore;
        bestScore = score;
        bestIdx = i;
      } else if (score > secondBestScore) {
        secondBestScore = score;
      }
    }

    // High confidence fuzzy match (>= 88% similarity) with a clear margin over any second best
    if (bestScore >= 0.88 && (bestScore - secondBestScore >= 0.15 || secondBestScore < 0.60)) {
      const startIdx = bestIdx;
      const newLines = normNew.split("\n");
      contentLines.splice(startIdx, oldLines.length, ...newLines);
      const updatedNorm = contentLines.join("\n");
      const updated = isCRLF ? updatedNorm.replace(/\n/g, "\r\n") : updatedNorm;
      validateSyntaxPreFlight(updated, filePath);
      return { updated, strategy: "fuzzy_similarity" };
    }
  }

  throw new Error("old_text was not found in the file. Read the file first and copy the exact snippet.");
}
