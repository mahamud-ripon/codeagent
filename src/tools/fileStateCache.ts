/**
 * File State Cache & Drift Detection.
 *
 * Inspired by Claude Code's fileStateCache.ts and fileHistory.ts:
 * - Maintains a snapshot history of files before any edit/write operation.
 * - Computes SHA-256 content hashes to detect external file drift (e.g. user edits,
 *   compiler updates, or git changes made between turns).
 * - Enables instant undo / rollback of modified files to any prior turn snapshot.
 */

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveInsideRepo } from "../utils/paths.js";

export interface FileSnapshot {
  filePath: string;
  content: string;
  hash: string;
  timestamp: number;
}

export interface DriftCheckResult {
  hasDrifted: boolean;
  expectedHash?: string;
  currentHash?: string;
  message?: string;
}

export function computeFileHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export class FileStateCache {
  // filePath -> array of snapshots (most recent last)
  private history: Map<string, FileSnapshot[]> = new Map();
  // filePath -> last observed hash (from read or write)
  private knownHashes: Map<string, string> = new Map();

  /**
   * Records a snapshot of the file's current content before an edit occurs.
   */
  async recordSnapshotBeforeEdit(repoRoot: string, relativePath: string): Promise<FileSnapshot | null> {
    const absolute = resolveInsideRepo(repoRoot, relativePath);
    try {
      const content = await fs.readFile(absolute, "utf8");
      const hash = computeFileHash(content);
      const snapshot: FileSnapshot = {
        filePath: relativePath,
        content,
        hash,
        timestamp: Date.now(),
      };

      const list = this.history.get(relativePath) ?? [];
      list.push(snapshot);
      if (list.length > 20) list.shift(); // retain last 20 snapshots per file
      this.history.set(relativePath, list);
      this.knownHashes.set(relativePath, hash);

      return snapshot;
    } catch {
      return null;
    }
  }

  /**
   * Records the hash observed during a read operation.
   */
  recordRead(relativePath: string, content: string): void {
    const hash = computeFileHash(content);
    this.knownHashes.set(relativePath, hash);
  }

  /**
   * Records the hash after a write/edit operation so the agent's own modifications
   * are known and do not trigger false external drift warnings.
   */
  recordWrite(relativePath: string, content: string): void {
    const hash = computeFileHash(content);
    this.knownHashes.set(relativePath, hash);
  }

  /**
   * Checks whether the file on disk has changed externally since it was last read.
   */
  async detectDrift(repoRoot: string, relativePath: string): Promise<DriftCheckResult> {
    const expectedHash = this.knownHashes.get(relativePath);
    if (!expectedHash) {
      return { hasDrifted: false };
    }

    const absolute = resolveInsideRepo(repoRoot, relativePath);
    try {
      const content = await fs.readFile(absolute, "utf8");
      const currentHash = computeFileHash(content);
      const hasDrifted = currentHash !== expectedHash;

      return {
        hasDrifted,
        expectedHash,
        currentHash,
        message: hasDrifted
          ? `File '${relativePath}' was modified externally since last read. Re-read before editing.`
          : undefined,
      };
    } catch {
      return { hasDrifted: true, message: `File '${relativePath}' was deleted or inaccessible.` };
    }
  }

  /**
   * Reverts a file to its snapshot prior to the most recent modification.
   */
  async rollback(repoRoot: string, relativePath: string): Promise<boolean> {
    const list = this.history.get(relativePath);
    if (!list || list.length === 0) return false;

    const previous = list.pop()!;
    const absolute = resolveInsideRepo(repoRoot, relativePath);
    await fs.writeFile(absolute, previous.content, "utf8");
    this.knownHashes.set(relativePath, previous.hash);
    return true;
  }

  getSnapshotCount(relativePath: string): number {
    return this.history.get(relativePath)?.length ?? 0;
  }
}
