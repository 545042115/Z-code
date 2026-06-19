// @z-assistant/runtime — shared memory
//
// Cross-agent shared memory. Agents reading/writing `project` or `global`
// scope memories use the same underlying provider, so shared context is
// naturally consistent. This module exposes typed helpers and a small
// conflict-resolution rule: newer memories win, and higher-importance
// memories win on ties.

import type { MemoryRecord, MemoryScope } from '@z-assistant/contracts';
import type { MemoryManager } from './memory-manager';

export interface SharedMemoryOptions {
  manager: MemoryManager;
  /** Default shared scope; default 'project'. */
  scope?: MemoryScope;
}

export class SharedMemory {
  private readonly scope: MemoryScope;

  constructor(
    private readonly manager: MemoryManager,
    scope: MemoryScope = 'project',
  ) {
    this.scope = scope;
  }

  /** Publish a memory to the shared scope so other agents can see it. */
  async publish(content: string, kind: 'long-term' | 'semantic' | 'procedural', extras?: Partial<MemoryRecord>): Promise<MemoryRecord> {
    return this.manager.remember(content, kind, this.scope, extras);
  }

  /** Read shared memories relevant to the query. */
  async read(query: string, limit = 10): Promise<MemoryRecord[]> {
    const hits = await this.manager.recall(query, { scope: this.scope, limit });
    return this.resolveConflicts(hits.map((h) => h.memory));
  }

  /**
   * Simple conflict resolution: if multiple memories have the same
   * content hash / key, keep the newest; on exact timestamp ties keep
   * the higher-importance one.
   */
  resolveConflicts(records: MemoryRecord[]): MemoryRecord[] {
    const map = new Map<string, MemoryRecord>();
    for (const r of records) {
      const key = (r.payload as { key?: string } | undefined)?.key ?? r.content;
      const existing = map.get(key);
      if (!existing) {
        map.set(key, r);
        continue;
      }
      const existingScore = (existing.importance ?? 0.5) + existing.createdAt / 1e12;
      const newScore = (r.importance ?? 0.5) + r.createdAt / 1e12;
      if (newScore > existingScore) {
        map.set(key, r);
      }
    }
    return [...map.values()].sort((a, b) => b.createdAt - a.createdAt);
  }
}
