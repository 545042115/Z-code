// @z-assistant/runtime — recall
//
// Universal `recall(query, scope)` entry point. Agents use this when they
// don't know which memory kind holds the answer; it searches across all
// kinds, filters by scope, and returns ranked hits.

import type { MemoryScope, MemoryKind, MemoryHit, MemoryQuery } from '@z-assistant/contracts';
import type { MemoryManager } from './memory-manager';

export interface RecallOptions {
  /** Target scope; defaults to the manager's default scope. */
  scope?: MemoryScope | MemoryScope[];
  /** Restrict to specific kinds. */
  kind?: MemoryKind | MemoryKind[];
  /** Max results; default 10. */
  limit?: number;
  /** Minimum relevance score; default 0.55. */
  minScore?: number;
}

/**
 * Recall memories across all kinds, optionally scoped.
 *
 *   const hits = await recall(memoryManager, "TypeScript style guide", {
 *     scope: ["user", "project"],
 *     limit: 5,
 *   });
 */
export async function recall(manager: MemoryManager, query: string, opts: RecallOptions = {}): Promise<MemoryHit[]> {
  const q: Partial<MemoryQuery> = {
    query,
    scope: opts.scope,
    kind: opts.kind,
    limit: opts.limit ?? 10,
    minScore: opts.minScore ?? 0.55,
  };
  return manager.recall(query, q);
}
