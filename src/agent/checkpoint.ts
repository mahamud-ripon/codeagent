import { createShadowCheckpoint, restoreShadowCheckpoint } from "../tools/git.js";

export interface CheckpointRecord {
  id: string;
  timestamp: number;
  label: string;
  commitHash: string;
}

export class CheckpointManager {
  private checkpoints: CheckpointRecord[] = [];

  constructor(private repoRoot: string) {}

  /**
   * Captures an ephemeral shadow snapshot of the repository state.
   */
  async saveCheckpoint(label = "turn"): Promise<CheckpointRecord | null> {
    const id = `cp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const commitHash = await createShadowCheckpoint(this.repoRoot, id, label);
    if (!commitHash) return null;

    const record: CheckpointRecord = {
      id,
      timestamp: Date.now(),
      label,
      commitHash,
    };
    this.checkpoints.push(record);
    return record;
  }

  /**
   * Reverts repository to the latest checkpoint.
   */
  async restoreLastCheckpoint(): Promise<CheckpointRecord | null> {
    if (this.checkpoints.length === 0) return null;
    const target = this.checkpoints.pop()!;
    const ok = await restoreShadowCheckpoint(this.repoRoot, target.id);
    if (!ok) {
      // If restore failed, push it back
      this.checkpoints.push(target);
      return null;
    }
    return target;
  }

  /**
   * Reverts repository to a specific checkpoint by ID.
   */
  async restoreCheckpoint(id: string): Promise<boolean> {
    const idx = this.checkpoints.findIndex((cp) => cp.id === id);
    if (idx === -1) return false;
    const ok = await restoreShadowCheckpoint(this.repoRoot, id);
    if (ok) {
      this.checkpoints = this.checkpoints.slice(0, idx);
      return true;
    }
    return false;
  }

  getLatest(): CheckpointRecord | null {
    return this.checkpoints.length > 0 ? this.checkpoints[this.checkpoints.length - 1] : null;
  }

  listCheckpoints(): CheckpointRecord[] {
    return [...this.checkpoints];
  }
}
