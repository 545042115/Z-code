// @ziner/runtime — memory policy
//
// Write-side policy: what to store, when to store it, and when to forget.
// The `MemoryPolicy` wraps a `MemoryManager` and enforces per-writer rules
// such as allowed kinds, rate limits, importance thresholds, and
// deduplication (exact or similarity-based).
//
// Retention policy: forget memories that have decayed below a threshold,
// using a combination of importance, age, and access frequency.

import type { MemoryKind, MemoryRecord, MemoryWritePolicy, MemoryHit } from '@ziner/contracts';
import type { MemoryManager } from './memory-manager';

export interface PolicyEnforcerOptions {
  manager: MemoryManager;
  policy?: MemoryWritePolicy;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** How to handle a duplicate / near-duplicate memory. */
export type DedupMode =
  | 'skip'        // 跳过，保留旧的
  | 'replace'     // 删除旧的，写入新的
  | 'merge'       // 合并内容，更新旧的（保留旧记录，更新内容和时间戳）
  | 'bump';       // 保留旧的，但更新 accessedAt 和 importance

export interface DedupOptions {
  /** Minimum similarity to consider a duplicate. Default 0.9. */
  similarityThreshold?: number;
  /** How to handle duplicates. Default 'merge'. */
  mode?: DedupMode;
  /** Maximum candidates to check. Default 10. */
  candidateLimit?: number;
}

/** Options for the retention / decay algorithm. */
export interface RetentionOptions {
  /** Importance at creation time decays by this fraction per day without access. Default 0.05 (5%/day). */
  decayPerDay?: number;
  /** Each access boosts importance by this much (capped at 1). Default 0.1. */
  accessBoost?: number;
  /** Minimum effective importance to keep. Default 0.2. */
  minEffectiveImportance?: number;
  /** Never delete memories younger than this (ms). Default 1 hour. */
  minAgeMs?: number;
  /** Max memories to scan per pass. Default 2000. */
  scanLimit?: number;
}

export class MemoryPolicy {
  constructor(
    private readonly manager: MemoryManager,
    private readonly policy: MemoryWritePolicy = {},
    private readonly dedupOpts: DedupOptions = {},
    private readonly retentionOpts: RetentionOptions = {},
  ) {}

  /** True if the policy allows writing this kind of memory. */
  allows(kind: MemoryKind): boolean {
    if (!this.policy.allowedKinds) return true;
    return this.policy.allowedKinds.includes(kind);
  }

  /**
   * Decide whether to store a candidate memory under the current policy.
   * Returns the stored record, or `undefined` if rejected.
   *
   * Deduplication:
   * - If `policy.deduplicate` is true, first checks exact matches
   * - If `dedupOpts.similarityThreshold` is set, also checks near-duplicates
   *   via semantic search and applies `dedupOpts.mode`
   */
  async maybeRemember(
    content: string,
    kind: MemoryKind,
    scope: 'session' | 'user' | 'agent' | 'project' | 'global',
    extras?: Partial<MemoryRecord>,
  ): Promise<MemoryRecord | undefined> {
    if (!this.allows(kind)) return undefined;

    const importance = extras?.importance ?? 0.5;
    if (this.policy.minImportance !== undefined && importance < this.policy.minImportance) {
      return undefined;
    }

    const windowMs = this.policy.windowMs ?? DAY_MS;
    const maxPerWindow = this.policy.maxPerWindow ?? 0;
    if (maxPerWindow > 0) {
      const recent = await this.manager.list({ kind, scope, limit: maxPerWindow * 2 });
      const windowStart = Date.now() - windowMs;
      const inWindow = recent.filter((r) => r.createdAt >= windowStart);
      if (inWindow.length >= maxPerWindow) {
        return undefined;
      }
    }

    // Exact deduplication (fast path)
    // Preserves original behaviour: delete old, insert new.
    if (this.policy.deduplicate && content) {
      const normalized = content.trim().toLowerCase();
      const existing = await this.manager.list({ kind, scope, limit: 50 });
      const dup = existing.find((r) => r.content.trim().toLowerCase() === normalized);
      if (dup) {
        await this.manager.forget(dup.id);
      }
    }

    // Similarity-based deduplication (semantic near-duplicates)
    const simThreshold = this.dedupOpts.similarityThreshold;
    if (simThreshold !== undefined && simThreshold > 0 && content) {
      const candidates = await this.manager.recall(content, {
        kind,
        scope,
        limit: this.dedupOpts.candidateLimit ?? 10,
        minScore: simThreshold,
      });
      if (candidates.length > 0) {
        const best = candidates[0];
        const mode = this.dedupOpts.mode ?? 'merge';
        return this._handleDup(best.memory, content, kind, scope, extras, mode);
      }
    }

    return this.manager.remember(content, kind, scope, extras);
  }

  /**
   * Compute the effective importance of a memory, factoring in decay and
   * access recency. Used by retention passes to decide what to forget.
   *
   * Formula:
   *   effective = baseImportance * (1 - decayPerDay)^days_since_last_access
   *             + accessBoost * access_count
   *
   * Result is clamped to [0, 1].
   */
  effectiveImportance(record: MemoryRecord): number {
    const decayPerDay = this.retentionOpts.decayPerDay ?? 0.05;
    const accessBoost = this.retentionOpts.accessBoost ?? 0.1;
    const base = record.importance ?? 0.5;
    const lastAccess = record.accessedAt ?? record.createdAt;
    const daysSinceAccess = Math.max(0, (Date.now() - lastAccess) / DAY_MS);
    const decayed = base * Math.pow(1 - decayPerDay, daysSinceAccess);
    const payload = record.payload as Record<string, unknown> | undefined;
    const accessCount = typeof payload?.accessCount === 'number' ? payload.accessCount : 0;
    const boosted = decayed + accessBoost * Math.min(accessCount, 10);
    return Math.max(0, Math.min(1, boosted));
  }

  /**
   * Apply a retention pass: soft-delete memories whose effective importance
   * has dropped below the threshold, and that are old enough to be eligible.
   *
   * Returns the number of memories deleted.
   */
  async applyRetentionPass(): Promise<number> {
    const minEffective = this.retentionOpts.minEffectiveImportance ?? 0.2;
    const minAgeMs = this.retentionOpts.minAgeMs ?? 60 * 60 * 1000;
    const scanLimit = this.retentionOpts.scanLimit ?? 2000;
    const cutoff = Date.now() - minAgeMs;

    const all = await this.manager.list({ includeDeleted: false, limit: scanLimit });
    let count = 0;
    for (const r of all) {
      if (r.createdAt > cutoff) continue;
      const effective = this.effectiveImportance(r);
      if (effective < minEffective) {
        const deleted = await this.manager.forget(r.id);
        if (deleted) count++;
      }
    }
    return count;
  }

  /**
   * Record an access to a memory, bumping its effective importance.
   * Returns the updated record, or undefined if not found.
   */
  async recordAccess(id: string): Promise<MemoryRecord | undefined> {
    const rec = await this.manager.get(id);
    if (!rec) return undefined;

    const payload = (rec.payload as Record<string, unknown>) ?? {};
    const accessCount = typeof payload.accessCount === 'number' ? payload.accessCount + 1 : 1;
    const accessBoost = this.retentionOpts.accessBoost ?? 0.1;
    const baseImportance = rec.importance ?? 0.5;
    const newImportance = Math.min(1, baseImportance + accessBoost);

    const updated: MemoryRecord = {
      ...rec,
      accessedAt: Date.now(),
      importance: newImportance,
      payload: { ...payload, accessCount },
    };
    return this.manager.provider.store(updated);
  }

  // ── Internals ───────────────────────────────────────────────────────

  private async _handleDup(
    existing: MemoryRecord,
    newContent: string,
    kind: MemoryKind,
    scope: 'session' | 'user' | 'agent' | 'project' | 'global',
    extras: Partial<MemoryRecord> | undefined,
    mode: DedupMode,
  ): Promise<MemoryRecord> {
    switch (mode) {
      case 'skip':
        return existing;

      case 'replace':
        await this.manager.forget(existing.id);
        return this.manager.remember(newContent, kind, scope, extras);

      case 'bump': {
        const updated: MemoryRecord = {
          ...existing,
          accessedAt: Date.now(),
          importance: Math.max(existing.importance ?? 0.5, extras?.importance ?? 0.5),
        };
        return this.manager.provider.store(updated);
      }

      case 'merge':
      default: {
        const payload = (existing.payload as Record<string, unknown>) ?? {};
        const newPayload = extras?.payload as Record<string, unknown> | undefined;
        const mergedPayload = { ...payload, ...newPayload };

        const mergedContent = this._mergeContent(existing.content, newContent);
        const updated: MemoryRecord = {
          ...existing,
          content: mergedContent,
          accessedAt: Date.now(),
          importance: Math.max(existing.importance ?? 0.5, extras?.importance ?? 0.5),
          payload: mergedPayload,
        };
        return this.manager.provider.store(updated);
      }
    }
  }

  /**
   * Merge two memory contents. If one is a clear superset, use the superset.
   * Otherwise, concatenate with a separator.
   */
  private _mergeContent(oldContent: string, newContent: string): string {
    const oldNorm = oldContent.trim().toLowerCase();
    const newNorm = newContent.trim().toLowerCase();
    if (oldNorm.includes(newNorm)) return oldContent;
    if (newNorm.includes(oldNorm)) return newContent;
    return `${oldContent}\n---\n${newContent}`;
  }
}
