// @ziner/runtime — long-term memory
//
// Durable cross-session facts and learnings. Use this for information
// that should persist across runs: user facts, project conventions,
// resolved decisions, error lessons, etc.

import type { MemoryRecord, MemoryHit } from '@ziner/contracts';
import type { MemoryManager } from './memory-manager';

export interface LongTermFact {
  content: string;
  /** Importance in [0, 1]; higher = retained longer. */
  importance?: number;
  /** Optional structured key/value payload. */
  payload?: Record<string, unknown>;
  runId?: string;
}

export class LongTermMemory {
  constructor(private readonly manager: MemoryManager) {}

  /** Remember a durable fact scoped to the user by default. */
  async remember(fact: LongTermFact, scope: 'user' | 'project' | 'global' = 'user'): Promise<MemoryRecord> {
    return this.manager.remember(
      fact.content,
      'long-term',
      scope,
      {
        importance: fact.importance ?? 0.7,
        payload: fact.payload,
        runId: fact.runId,
      },
    );
  }

  /** Recall durable facts relevant to the query. */
  async recall(query: string, limit = 10): Promise<MemoryHit[]> {
    return this.manager.recall(query, { kind: 'long-term', limit });
  }

  /** List all durable facts for the current user / project. */
  async list(limit = 100): Promise<MemoryRecord[]> {
    return this.manager.list({ kind: 'long-term', limit });
  }
}
