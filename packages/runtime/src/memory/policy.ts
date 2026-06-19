// @z-assistant/runtime — memory policy
//
// Write-side policy: what to store, when to store it, and when to forget.
// The `MemoryPolicy` wraps a `MemoryManager` and enforces per-writer rules
// such as allowed kinds, rate limits, importance thresholds, and simple
// deduplication.

import type { MemoryKind, MemoryRecord, MemoryWritePolicy } from '@z-assistant/contracts';
import type { MemoryManager } from './memory-manager';

export interface PolicyEnforcerOptions {
  manager: MemoryManager;
  policy?: MemoryWritePolicy;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export class MemoryPolicy {
  constructor(
    private readonly manager: MemoryManager,
    private readonly policy: MemoryWritePolicy = {},
  ) {}

  /** True if the policy allows writing this kind of memory. */
  allows(kind: MemoryKind): boolean {
    if (!this.policy.allowedKinds) return true;
    return this.policy.allowedKinds.includes(kind);
  }

  /**
   * Decide whether to store a candidate memory under the current policy.
   * Returns the stored record, or `undefined` if rejected.
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

    if (this.policy.deduplicate && content) {
      const normalized = content.trim().toLowerCase();
      const existing = await this.manager.list({ kind, scope, limit: 50 });
      const dup = existing.find((r) => r.content.trim().toLowerCase() === normalized);
      if (dup) {
        await this.manager.forget(dup.id);
      }
    }

    return this.manager.remember(content, kind, scope, extras);
  }

  /**
   * Apply a retention pass: soft-delete memories whose importance is below
   * the threshold and that haven't been accessed recently.
   */
  async applyRetention(minImportance: number, maxAgeMs: number): Promise<number> {
    const cutoff = Date.now() - maxAgeMs;
    const all = await this.manager.list({ includeDeleted: false, limit: 10000 });
    let count = 0;
    for (const r of all) {
      const importance = r.importance ?? 0.5;
      const lastAccess = r.accessedAt ?? r.createdAt;
      if (importance < minImportance && lastAccess < cutoff) {
        await this.manager.forget(r.id);
        count++;
      }
    }
    return count;
  }
}
