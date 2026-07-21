// MobileCheckpointStore — localStorage-backed CheckpointStore.
//
// Persists plan-mode checkpoints on the device so a user-cancelled or
// crashed multi-agent run can be resumed. Storage layout:
//
//   ziner.checkpoints.index  -> CheckpointIndexEntry[]
//   ziner.checkpoints.<runId> -> Checkpoint
//
// localStorage is synchronous and limited (~5-10 MB), so this store:
//   - keeps the index lightweight
//   - caps total entries at 100 (LRU by updatedAt)
//   - skips persistence when localStorage is unavailable

import type {
  Checkpoint,
  CheckpointIndexEntry,
  CheckpointStore,
} from '@ziner/runtime-core';

export interface MobileCheckpointStoreOptions {
  /** localStorage key prefix. */
  prefix?: string;
  /** Max checkpoints to keep. */
  maxEntries?: number;
  /** TTL in ms (default 7 days). */
  ttlMs?: number;
}

export class MobileCheckpointStore implements CheckpointStore {
  private readonly prefix: string;
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly indexKey: string;

  constructor(options: MobileCheckpointStoreOptions = {}) {
    this.prefix = options.prefix ?? 'ziner.checkpoints';
    this.maxEntries = options.maxEntries ?? 100;
    this.ttlMs = options.ttlMs ?? 7 * 24 * 60 * 60 * 1000;
    this.indexKey = `${this.prefix}.index`;
  }

  private get storage(): Storage | null {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  }

  private checkpointKey(runId: string): string {
    return `${this.prefix}.${runId}`;
  }

  /** Persist (or update) a checkpoint and refresh the index. */
  async save(checkpoint: Checkpoint): Promise<void> {
    const storage = this.storage;
    if (!storage) return;

    const existing = await this.loadRaw(checkpoint.runId);
    const merged: Checkpoint = existing
      ? {
          ...existing,
          ...checkpoint,
          subtaskOutputs: { ...existing.subtaskOutputs, ...checkpoint.subtaskOutputs },
          completedSubTaskIds: mergeIdList(existing.completedSubTaskIds, checkpoint.completedSubTaskIds),
          createdAt: existing.createdAt,
          updatedAt: Date.now(),
        }
      : {
          ...checkpoint,
          createdAt: checkpoint.createdAt || Date.now(),
          updatedAt: Date.now(),
        };

    storage.setItem(this.checkpointKey(checkpoint.runId), JSON.stringify(merged));
    await this.rebuildIndex();
  }

  /** Load a checkpoint by runId. Returns null if not found. */
  async load(runId: string): Promise<Checkpoint | null> {
    return this.loadRaw(runId);
  }

  private loadRaw(runId: string): Checkpoint | null {
    const storage = this.storage;
    if (!storage) return null;
    try {
      const text = storage.getItem(this.checkpointKey(runId));
      if (!text) return null;
      return JSON.parse(text) as Checkpoint;
    } catch (e) {
      console.warn('[MobileCheckpointStore] load failed:', e);
      return null;
    }
  }

  /** Delete a checkpoint. No-op if it doesn't exist. */
  async delete(runId: string): Promise<void> {
    const storage = this.storage;
    if (!storage) return;
    storage.removeItem(this.checkpointKey(runId));
    await this.rebuildIndex();
  }

  /** List checkpoints (most recently updated first). */
  async list(options?: { sessionId?: string; limit?: number }): Promise<CheckpointIndexEntry[]> {
    let entries = await this.readIndex();
    if (options?.sessionId) {
      entries = entries.filter((e) => e.sessionId === options.sessionId);
    }
    entries.sort((a, b) => b.updatedAt - a.updatedAt);
    if (options?.limit) entries = entries.slice(0, options.limit);
    return entries;
  }

  /** Remove stale entries and enforce maxEntries. */
  async cleanup(): Promise<{ removed: number }> {
    const storage = this.storage;
    if (!storage) return { removed: 0 };

    const now = Date.now();
    let entries = await this.readIndex();
    const toRemove = new Set<string>();

    for (const e of entries) {
      if (now - e.updatedAt > this.ttlMs) toRemove.add(e.runId);
    }

    if (entries.length - toRemove.size > this.maxEntries) {
      const survivors = entries
        .filter((e) => !toRemove.has(e.runId))
        .sort((a, b) => b.updatedAt - a.updatedAt);
      for (const e of survivors.slice(this.maxEntries)) toRemove.add(e.runId);
    }

    for (const runId of toRemove) {
      storage.removeItem(this.checkpointKey(runId));
    }

    if (toRemove.size > 0) await this.rebuildIndex();
    return { removed: toRemove.size };
  }

  private async readIndex(): Promise<CheckpointIndexEntry[]> {
    const storage = this.storage;
    if (!storage) return [];
    try {
      const text = storage.getItem(this.indexKey);
      if (!text) return [];
      const parsed = JSON.parse(text);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private async rebuildIndex(): Promise<CheckpointIndexEntry[]> {
    const storage = this.storage;
    if (!storage) return [];

    const entries: CheckpointIndexEntry[] = [];
    const prefix = `${this.prefix}.`;
    const keys: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key && key.startsWith(prefix) && key !== this.indexKey) keys.push(key);
    }

    for (const key of keys) {
      const runId = key.slice(prefix.length);
      const ck = this.loadRaw(runId);
      if (!ck) continue;
      entries.push({
        runId: ck.runId,
        task: ck.task,
        sessionId: ck.sessionId,
        status: ck.status,
        completedCount: ck.completedSubTaskIds.length,
        totalCount: ck.planDag.subtasks.length,
        createdAt: ck.createdAt,
        updatedAt: ck.updatedAt,
      });
    }

    entries.sort((a, b) => b.updatedAt - a.updatedAt);
    storage.setItem(this.indexKey, JSON.stringify(entries));
    return entries;
  }
}

function mergeIdList(a: string[], b: string[]): string[] {
  const out = new Set(a);
  for (const id of b) out.add(id);
  return [...out];
}
