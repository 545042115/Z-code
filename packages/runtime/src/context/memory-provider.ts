// @ziner/runtime — MemoryContextProvider
//
// Context provider that pulls relevant memories (episodic, long-term,
// semantic, etc.) and surfaces them as ContextChunk. This lets the
// agent recall past experiences and user preferences automatically.

import type {
  IContextProvider,
  ContextChunk,
  ContextSource,
  TaskContext,
  MemoryKind,
  MemoryRecord,
  MemoryHit,
} from '@ziner/contracts';
import type { MemoryManager } from '../memory/memory-manager';

export interface MemoryContextProviderOptions {
  /** Which memory kinds to search. Default: all except short-term. */
  kinds?: MemoryKind[];
  /** Priority for budget allocation. Default 45. */
  priority?: number;
  /** Default limit for recall. Default 8. */
  defaultLimit?: number;
  /** Minimum relevance score. Default 0.55. */
  minScore?: number;
  /** Provider name. Default 'memory'. */
  name?: string;
  /**
   * Diversify results by memory kind — ensures each kind gets
   * at least this many slots when available. Default true.
   */
  diversify?: boolean;
}

const DEFAULT_KINDS: MemoryKind[] = ['episodic', 'long-term', 'semantic', 'procedural', 'preference'];

export class MemoryContextProvider implements IContextProvider {
  readonly name: string;
  private readonly manager: MemoryManager;
  private readonly kinds: MemoryKind[];
  private readonly priority: number;
  private readonly defaultLimit: number;
  private readonly minScore: number;
  private readonly diversify: boolean;

  constructor(manager: MemoryManager, opts: MemoryContextProviderOptions = {}) {
    this.manager = manager;
    this.name = opts.name ?? 'memory';
    this.kinds = opts.kinds ?? DEFAULT_KINDS;
    this.priority = opts.priority ?? 45;
    this.defaultLimit = opts.defaultLimit ?? 8;
    this.minScore = opts.minScore ?? 0.55;
    this.diversify = opts.diversify !== false;
  }

  source(): ContextSource {
    return {
      name: this.name,
      role: 'memory recall',
      priority: this.priority,
      maxChunks: this.defaultLimit,
    };
  }

  async fetch(ctx: TaskContext, query: string, limit?: number): Promise<ContextChunk[]> {
    const effectiveLimit = limit ?? this.defaultLimit;
    if (!query || query.trim().length === 0) return [];

    try {
      // Fetch extra candidates so we have room for diversity re-ranking
      const fetchLimit = this.diversify ? Math.max(effectiveLimit * 3, 20) : effectiveLimit;
      const hits = await this.manager.recall(query, {
        kind: this.kinds,
        limit: fetchLimit,
        minScore: this.minScore * 0.85,
        scope: ctx.userId ? ['user', 'project'] : ['project'],
      });

      let selected: typeof hits;
      if (this.diversify) {
        selected = this._diversifyByKind(hits, effectiveLimit);
      } else {
        selected = hits.slice(0, effectiveLimit);
      }

      return selected.map((hit) => ({
        id: hit.memory.id,
        source: this.name,
        content: this._formatHit(hit),
        score: hit.score,
        tags: [
          `kind:${hit.memory.kind}`,
          `scope:${hit.memory.scope}`,
          ...this._extractTags(hit.memory.payload),
        ],
      }));
    } catch {
      return [];
    }
  }

  /**
   * Diversify recall results by memory kind using a greedy round-robin approach.
   * Ensures underrepresented kinds still get slots when relevant hits exist.
   */
  private _diversifyByKind(hits: MemoryHit[], limit: number): MemoryHit[] {
    if (hits.length <= limit) return hits;

    const byKind = new Map<MemoryKind, MemoryHit[]>();
    for (const hit of hits) {
      const list = byKind.get(hit.memory.kind) || [];
      list.push(hit);
      byKind.set(hit.memory.kind, list);
    }

    const kinds = [...byKind.keys()];
    const result: MemoryHit[] = [];
    const indices = new Map<MemoryKind, number>();
    for (const k of kinds) indices.set(k, 0);

    // Round-robin pick from each kind, respecting score order within each kind
    let round = 0;
    while (result.length < limit) {
      let addedThisRound = 0;
      for (const kind of kinds) {
        if (result.length >= limit) break;
        const list = byKind.get(kind)!;
        const idx = indices.get(kind)!;
        if (idx < list.length) {
          // Only include if the score is still reasonable (not too far from the best)
          const bestScore = list[0].score;
          if (list[idx].score >= bestScore * 0.6 || round === 0) {
            result.push(list[idx]);
            indices.set(kind, idx + 1);
            addedThisRound++;
          }
        }
      }
      if (addedThisRound === 0) break;
      round++;
    }

    // If we didn't fill the limit, pad with highest-scoring remaining
    if (result.length < limit) {
      const usedIds = new Set(result.map((h) => h.memory.id));
      const remaining = hits.filter((h) => !usedIds.has(h.memory.id));
      result.push(...remaining.slice(0, limit - result.length));
    }

    // Re-sort final result by score for quality
    return result.sort((a, b) => b.score - a.score);
  }

  private _formatHit(hit: { memory: MemoryRecord; score: number }): string {
    const { memory } = hit;
    const kindLabel = this._kindLabel(memory.kind);
    const payload = memory.payload as Record<string, unknown> | undefined;

    let header = `[${kindLabel}]`;
    if (payload?.task && typeof payload.task === 'string') {
      header += ` ${payload.task}`;
    }
    if (payload?.outcome && typeof payload.outcome === 'string') {
      header += ` (outcome: ${payload.outcome})`;
    }

    return `${header}\n${memory.content}`;
  }

  private _extractTags(payload: Record<string, unknown> | undefined): string[] {
    if (!payload?.tags || !Array.isArray(payload.tags)) return [];
    return payload.tags.filter((t): t is string => typeof t === 'string');
  }

  private _kindLabel(kind: MemoryKind): string {
    const labels: Record<MemoryKind, string> = {
      'short-term': 'Recent Chat',
      'long-term': 'Memory',
      'episodic': 'Past Task',
      'semantic': 'Knowledge',
      'procedural': 'How-to',
      'preference': 'Preference',
    };
    return labels[kind] ?? kind;
  }
}
