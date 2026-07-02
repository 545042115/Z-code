// @ziner/runtime — Checkpoint Manager
//
// Persists per-sub-task run state so a plan-mode Orchestrator run can
// be resumed after a crash / user-cancel. A checkpoint is created
// automatically after every sub-task completes; on `resumeFrom`, the
// Orchestrator rebuilds the SharedState and skips the sub-tasks that
// already have a stored output.
//
// Storage layout:
//
//   <rootDir>/
//     checkpoints/
//       <runId>.json          # latest checkpoint for the run
//       <runId>.json.tmp     # atomic-write scratch file
//       index.json            # list of {runId, task, sessionId, status, ...}
//
// Atomic writes use the write-temp + fsync + rename pattern so a
// crash mid-write never produces a half-written checkpoint file.

import { promises as fsp } from 'fs';
import { join } from 'path';
import type { PlanDag } from '@ziner/contracts';

/**
 * Status of a checkpoint / its parent run.
 *   - 'in_progress'  — at least one sub-task completed; run is not finished
 *   - 'completed'    — all sub-tasks done; the run reached a final state
 *   - 'cancelled'    — the run was aborted by the user (via cancelRun)
 *   - 'failed'       — the run crashed (e.g. uncaught throw, budget exhausted)
 */
export type CheckpointStatus = 'in_progress' | 'completed' | 'cancelled' | 'failed';

export interface Checkpoint {
  /** Stable run id (matches the RunTracker.id). */
  runId: string;
  /** The original user task. */
  task: string;
  /** Run mode (plan / dag). */
  mode: 'plan' | 'dag' | string;
  /** Session id (for cross-session resume + recent-message loading). */
  sessionId: string;
  /** The full PlanDag produced by the Planner. */
  planDag: PlanDag;
  /** Sub-task ids whose `output` is already in `subtaskOutputs`. */
  completedSubTaskIds: string[];
  /** Final SubTaskResult for each completed sub-task. */
  subtaskOutputs: Record<string, SubTaskResult>;
  /** Snapshot of the SharedState at the point of the last save. */
  sharedState: Record<string, { value: unknown; version: number; updatedAt: number; writer?: string }>;
  /** Planner / Synthesizer agent names, for dispatch fallback. */
  plannerAgent: string;
  synthesizerAgent: string;
  /** Routing seed at the time of the original run. */
  routerSeed?: string[];
  /** When the checkpoint was first created. */
  createdAt: number;
  /** When the checkpoint was last updated. */
  updatedAt: number;
  /** Current status. */
  status: CheckpointStatus;
}

export interface SubTaskResult {
  ok: boolean;
  output?: unknown;
  error?: { code: string; message: string };
  agent: string;
  durationMs?: number;
  completedAt: number;
}

export interface CheckpointIndexEntry {
  runId: string;
  task: string;
  sessionId: string;
  status: CheckpointStatus;
  completedCount: number;
  totalCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface CheckpointManagerOptions {
  /** Directory where checkpoints/<runId>.json live. */
  rootDir: string;
  /** Max age (ms) before a checkpoint is purged by `cleanup()`. */
  ttlMs?: number;
  /** Max total entries to keep (LRU by `updatedAt`). */
  maxEntries?: number;
}

export class CheckpointManager {
  private readonly dir: string;
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(opts: CheckpointManagerOptions) {
    this.dir = join(opts.rootDir, 'checkpoints');
    this.ttlMs = opts.ttlMs ?? 7 * 24 * 60 * 60 * 1000; // 7 days
    this.maxEntries = opts.maxEntries ?? 200;
  }

  private async ensureDir(): Promise<void> {
    await fsp.mkdir(this.dir, { recursive: true });
  }

  private fileFor(runId: string): string {
    return join(this.dir, `${runId}.json`);
  }

  private tmpFor(runId: string): string {
    return join(this.dir, `${runId}.json.tmp`);
  }

  private indexFile(): string {
    return join(this.dir, 'index.json');
  }

  /**
   * Persist (or update) a checkpoint atomically. Subsequent calls with
   * the same `runId` merge `subtaskOutputs` and `completedSubTaskIds`
   * and refresh `updatedAt`.
   */
  async save(checkpoint: Checkpoint): Promise<void> {
    await this.ensureDir();
    const existing = await this.loadRaw(checkpoint.runId);
    const merged: Checkpoint = existing
      ? {
          ...existing,
          ...checkpoint,
          subtaskOutputs: { ...existing.subtaskOutputs, ...checkpoint.subtaskOutputs },
          completedSubTaskIds: this._mergeIdList(
            existing.completedSubTaskIds,
            checkpoint.completedSubTaskIds,
          ),
          createdAt: existing.createdAt,
          updatedAt: Date.now(),
        }
      : {
          ...checkpoint,
          createdAt: checkpoint.createdAt || Date.now(),
          updatedAt: Date.now(),
        };
    await this._writeAtomic(this.fileFor(checkpoint.runId), merged);
    await this._rebuildIndex();
  }

  private _mergeIdList(a: string[], b: string[]): string[] {
    const out = new Set(a);
    for (const id of b) out.add(id);
    return [...out];
  }

  private async _writeAtomic(path: string, data: unknown): Promise<void> {
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    const json = JSON.stringify(data, null, 2);
    const fh = await fsp.open(tmp, 'w');
    try {
      await fh.writeFile(json, 'utf8');
      await fh.sync();
    } finally {
      await fh.close();
    }
    await fsp.rename(tmp, path);
  }

  private async loadRaw(runId: string): Promise<Checkpoint | null> {
    try {
      const text = await fsp.readFile(this.fileFor(runId), 'utf8');
      return JSON.parse(text) as Checkpoint;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  }

  /** Load a checkpoint by runId. Returns null if not found. */
  async load(runId: string): Promise<Checkpoint | null> {
    return this.loadRaw(runId);
  }

  /** Delete a checkpoint. No-op if it doesn't exist. */
  async delete(runId: string): Promise<void> {
    try {
      await fsp.unlink(this.fileFor(runId));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    await this._rebuildIndex();
  }

  /**
   * List all checkpoints (for the Trace panel / desktop UI). Optionally
   * filter by `sessionId`. Sorted by `updatedAt` descending.
   */
  async list(opts?: { sessionId?: string; limit?: number }): Promise<CheckpointIndexEntry[]> {
    let entries: CheckpointIndexEntry[] = [];
    try {
      const text = await fsp.readFile(this.indexFile(), 'utf8');
      entries = JSON.parse(text) as CheckpointIndexEntry[];
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      // No index yet — rebuild from disk.
      entries = await this._rebuildIndex();
    }
    if (opts?.sessionId) {
      entries = entries.filter((e) => e.sessionId === opts.sessionId);
    }
    entries.sort((a, b) => b.updatedAt - a.updatedAt);
    if (opts?.limit) entries = entries.slice(0, opts.limit);
    return entries;
  }

  /**
   * Remove checkpoints older than `ttlMs` AND enforce `maxEntries`
   * (LRU by `updatedAt`). Call on Connector startup to keep storage
   * bounded.
   */
  async cleanup(): Promise<{ removed: number }> {
    await this.ensureDir();
    const now = Date.now();
    const entries = await this._rebuildIndex();
    const toRemove = new Set<string>();
    for (const e of entries) {
      if (now - e.updatedAt > this.ttlMs) toRemove.add(e.runId);
    }
    // Cap by maxEntries, keeping the most-recently-updated.
    if (entries.length - toRemove.size > this.maxEntries) {
      const survivors = entries
        .filter((e) => !toRemove.has(e.runId))
        .sort((a, b) => b.updatedAt - a.updatedAt);
      for (const e of survivors.slice(this.maxEntries)) toRemove.add(e.runId);
    }
    for (const runId of toRemove) {
      try {
        await fsp.unlink(this.fileFor(runId));
      } catch {
        /* ignore */
      }
    }
    if (toRemove.size > 0) await this._rebuildIndex();
    return { removed: toRemove.size };
  }

  /** Rebuild index.json from on-disk checkpoints. */
  private async _rebuildIndex(): Promise<CheckpointIndexEntry[]> {
    await this.ensureDir();
    const entries: CheckpointIndexEntry[] = [];
    let dirents: string[] = [];
    try {
      dirents = await fsp.readdir(this.dir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw e;
    }
    for (const name of dirents) {
      if (!name.endsWith('.json') || name === 'index.json') continue;
      const runId = name.slice(0, -'.json'.length);
      const ck = await this.loadRaw(runId);
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
    await this._writeAtomic(this.indexFile(), entries);
    return entries;
  }
}
