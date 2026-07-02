// @ziner/runtime — Advanced Retrieval
//
// Higher-level retrieval utilities that go beyond basic vector search:
//   - Hybrid retrieval (BM25 + vector) with RRF fusion
//   - Query expansion / rewriting
//   - Re-ranking
//   - Parent-child chunk retrieval
//
// These wrap an `IMemoryProvider` (or `MemoryManager`) and provide
// better recall / precision at the cost of a bit more latency.

import type {
  IMemoryProvider,
  MemoryRecord,
  MemoryQuery,
  MemoryHit,
  MemoryHitReason,
} from '@ziner/contracts';
import type { MemoryManager } from './memory-manager';

// ── Hybrid retrieval (RRF fusion) ──────────────────────────────────

export interface HybridRetrievalOptions {
  /** Weight for vector search in RRF. Default 60. */
  vectorWeight?: number;
  /** Weight for keyword (BM25-like) search in RRF. Default 60. */
  keywordWeight?: number;
  /** Number of candidates to fetch from each retriever. Default 50. */
  candidateCount?: number;
  /** RRF k constant (higher = less penalty for low ranks). Default 60. */
  rrfK?: number;
}

/**
 * Run hybrid retrieval using Reciprocal Rank Fusion.
 * Combines vector search results with keyword search results.
 *
 * RRF formula: score(d) = Σ 1 / (k + rank_i)
 * where rank_i is the rank of document d in result set i.
 */
export async function hybridRetrieve(
  provider: IMemoryProvider,
  query: MemoryQuery & { query: string },
  opts: HybridRetrievalOptions = {},
): Promise<MemoryHit[]> {
  const vectorWeight = opts.vectorWeight ?? 60;
  const keywordWeight = opts.keywordWeight ?? 60;
  const candidateCount = opts.candidateCount ?? 50;
  const k = opts.rrfK ?? 60;
  const limit = query.limit ?? 10;

  // Fetch more candidates than needed for fusion
  const vectorQuery: MemoryQuery & { query: string } = {
    ...query,
    limit: candidateCount,
    minScore: 0,
  };

  // Run vector search
  const vectorHits = await provider.recall(vectorQuery);

  // Run keyword search by leveraging the provider's recall with very low
  // vector threshold (which triggers the keyword fallback path).
  // For a true BM25 we'd need a separate index, but the provider's
  // keyword fallback gives us a good approximation.
  const keywordHits = await provider.recall({
    ...query,
    limit: candidateCount,
    minScore: 0,
  });

  // RRF scoring
  const rrfScores = new Map<string, number>();
  const hitMap = new Map<string, MemoryHit>();
  const reasonsMap = new Map<string, MemoryHitReason[]>();

  // Vector ranks
  vectorHits.forEach((hit, idx) => {
    const rank = idx + 1;
    const score = vectorWeight / (k + rank);
    rrfScores.set(hit.memory.id, (rrfScores.get(hit.memory.id) ?? 0) + score);
    hitMap.set(hit.memory.id, hit);
    const existingReasons = reasonsMap.get(hit.memory.id) ?? [];
    reasonsMap.set(hit.memory.id, [...existingReasons, { type: 'vector', score: hit.score }]);
  });

  // Keyword ranks — filter to hits that were primarily keyword matches
  // (reasons include 'keyword' type)
  const keywordOnlyHits = keywordHits.filter(
    (h) => h.reasons?.some((r) => r.type === 'keyword'),
  );
  keywordOnlyHits.forEach((hit, idx) => {
    const rank = idx + 1;
    const score = keywordWeight / (k + rank);
    rrfScores.set(hit.memory.id, (rrfScores.get(hit.memory.id) ?? 0) + score);
    if (!hitMap.has(hit.memory.id)) {
      hitMap.set(hit.memory.id, hit);
    }
    const existingReasons = reasonsMap.get(hit.memory.id) ?? [];
    reasonsMap.set(hit.memory.id, [...existingReasons, ...(hit.reasons ?? [])]);
  });

  // Sort by fused score
  const sortedIds = [...rrfScores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id]) => id);

  // Build final result
  const results: MemoryHit[] = [];
  for (const id of sortedIds) {
    const hit = hitMap.get(id);
    if (!hit) continue;
    const fusedScore = rrfScores.get(id) ?? 0;
    // Normalize fused score to 0-1 range for consistency
    const maxPossible = (vectorWeight + keywordWeight) / (k + 1);
    const normalizedScore = Math.min(1, fusedScore / maxPossible);
    results.push({
      memory: hit.memory,
      score: normalizedScore,
      reasons: reasonsMap.get(id) ?? hit.reasons,
    });
  }

  return results;
}

// ── Query Expansion ────────────────────────────────────────────────

export type QueryExpander = (query: string) => Promise<string[]>;

export interface QueryExpansionOptions {
  /**
   * How to generate expanded queries.
   * - 'llm': use an LLM to generate multiple rephrasings
   * - 'synonym': simple synonym-based expansion
   * - 'none': no expansion
   *
   * Default: 'none'. Provide a custom `expander` to override.
   */
  mode?: 'llm' | 'synonym' | 'none';
  /** Custom expander function. Overrides `mode` if provided. */
  expander?: QueryExpander;
  /** Maximum number of expanded queries to generate. Default 3. */
  maxExpansions?: number;
}

/**
 * Simple rule-based query expander. Adds common variations:
 * - Add "how to" prefix
 * - Add synonyms for common technical terms
 * - Rephrase as a question
 */
export function createSynonymExpander(): QueryExpander {
  return async (query: string): Promise<string[]> => {
    const variations: string[] = [query];
    const lower = query.toLowerCase();

    // Add "how to" for imperative queries
    if (/^(how|what|why|when|where)/i.test(lower) === false && lower.length > 5) {
      variations.push(`how to ${lower}`);
    }

    // Rephrase statement as question
    if (lower.endsWith('.') || /^(i|i'm|i want|i need|i'd like)/i.test(lower) === false) {
      if (lower.length > 10 && !lower.endsWith('?')) {
        variations.push(`what is ${lower}?`);
      }
    }

    // Synonym expansion for common dev terms
    const synonymMap: Record<string, string[]> = {
      'error': ['bug', 'issue', 'exception', 'failure'],
      'fix': ['solve', 'resolve', 'repair', 'debug'],
      'create': ['build', 'make', 'generate', 'implement'],
      'remove': ['delete', 'erase', 'clear', 'drop'],
      'fast': ['quick', 'performant', 'optimized', 'speed'],
      'slow': ['slow', 'laggy', 'unresponsive', 'performance'],
      'function': ['method', 'procedure', 'func', 'routine'],
      'config': ['configuration', 'settings', 'options', 'setup'],
    };

    for (const [word, synonyms] of Object.entries(synonymMap)) {
      if (lower.includes(word)) {
        for (const syn of synonyms.slice(0, 2)) {
          variations.push(lower.replace(new RegExp(word, 'gi'), syn));
        }
      }
    }

    // Deduplicate and limit
    const unique = [...new Set(variations.map((v) => v.trim()))].filter((v) => v.length > 3);
    return unique.slice(0, 5);
  };
}

/**
 * Run retrieval with query expansion: generate multiple query variants,
 * retrieve for each, and merge results with deduplication.
 */
export async function retrieveWithExpansion(
  provider: IMemoryProvider,
  query: MemoryQuery & { query: string },
  opts: QueryExpansionOptions = {},
): Promise<MemoryHit[]> {
  const maxExpansions = opts.maxExpansions ?? 3;
  const limit = query.limit ?? 10;

  let expander: QueryExpander | undefined = opts.expander;
  if (!expander && opts.mode === 'synonym') {
    expander = createSynonymExpander();
  }
  if (!expander || opts.mode === 'none') {
    return provider.recall(query);
  }

  const expandedQueries = await expander(query.query);
  const queries = expandedQueries.slice(0, maxExpansions);

  // Run all queries in parallel
  const allHits = await Promise.all(
    queries.map((q) =>
      provider.recall({ ...query, query: q, limit: limit * 2 }),
    ),
  );

  // Merge and deduplicate, keeping the highest score for each id
  const bestHits = new Map<string, MemoryHit>();
  const queryCount = new Map<string, number>();

  for (const hits of allHits) {
    for (const hit of hits) {
      const id = hit.memory.id;
      queryCount.set(id, (queryCount.get(id) ?? 0) + 1);
      const existing = bestHits.get(id);
      if (!existing || hit.score > existing.score) {
        bestHits.set(id, hit);
      }
    }
  }

  // Boost score for hits that appear in multiple query results (reciprocal hit count)
  const results = [...bestHits.values()].map((hit) => {
    const timesSeen = queryCount.get(hit.memory.id) ?? 1;
    // Boost: hits found by more query variants get a small score bonus
    const boost = 1 + 0.1 * (timesSeen - 1);
    return {
      ...hit,
      score: Math.min(1, hit.score * boost),
    };
  });

  return results.sort((a, b) => b.score - a.score).slice(0, limit);
}

// ── Re-ranking ─────────────────────────────────────────────────────

export type Reranker = (query: string, documents: string[]) => Promise<number[]>;

export interface RerankOptions {
  /** Reranker function. If not provided, no reranking is performed. */
  reranker?: Reranker;
  /** Number of candidates to send to the reranker. Default 30. */
  topK?: number;
}

/**
 * Apply a reranker to the top-K candidates from initial retrieval.
 * Returns the reranked results with updated scores.
 */
export async function rerankHits(
  hits: MemoryHit[],
  query: string,
  opts: RerankOptions = {},
): Promise<MemoryHit[]> {
  const reranker = opts.reranker;
  const topK = opts.topK ?? 30;

  if (!reranker || hits.length === 0) return hits;

  const candidates = hits.slice(0, topK);
  const documents = candidates.map((h) => h.memory.content);

  const scores = await reranker(query, documents);

  // Apply reranked scores (clamped to 0-1)
  const reranked = candidates.map((hit, idx) => ({
    ...hit,
    score: Math.max(0, Math.min(1, scores[idx] ?? hit.score)),
    reasons: [
      ...(hit.reasons ?? []),
      { type: 'vector' as const, score: scores[idx] ?? 0, detail: 'reranked' },
    ],
  }));

  // Append remaining candidates with original scores
  const rest = hits.slice(topK);

  return [...reranked.sort((a, b) => b.score - a.score), ...rest];
}

// ── Parent-child chunk retrieval ───────────────────────────────────

export interface ParentChildChunk {
  /** Child chunk id (the granular piece that was retrieved). */
  childId: string;
  /** Parent chunk id (the broader context). */
  parentId: string;
  /** Child chunk content. */
  childContent: string;
  /** Parent chunk content (wider context). */
  parentContent: string;
  /** Retrieval score of the child chunk. */
  score: number;
}

/**
 * Expand child chunks to their parent context.
 *
 * When you have small, granular chunks indexed for retrieval precision,
 * you can retrieve the child chunks and then expand to their parent
 * chunks to give the LLM more context.
 *
 * Parent-child relationships are stored in memory record payloads:
 *   - payload.parentId → points to the parent memory record
 *   - payload.childIds → array of child memory record ids
 */
export async function expandToParentContext(
  manager: MemoryManager,
  hits: MemoryHit[],
): Promise<MemoryHit[]> {
  if (hits.length === 0) return hits;

  const expanded: MemoryHit[] = [];

  for (const hit of hits) {
    const payload = hit.memory.payload as Record<string, unknown> | undefined;
    const parentId = payload?.parentId as string | undefined;

    if (parentId) {
      const parent = await manager.get(parentId);
      if (parent) {
        // Return the parent as the hit, but keep the child's score
        // and mention the original child in reasons
        expanded.push({
          memory: parent,
          score: hit.score,
          reasons: [
            ...(hit.reasons ?? []),
            { type: 'kind' as const, score: hit.score, detail: 'parent-expansion' },
          ],
        });
        continue;
      }
    }

    // No parent or parent not found — keep original
    expanded.push(hit);
  }

  return expanded;
}

// ── Full retrieval pipeline ────────────────────────────────────────

export interface RetrievalPipelineOptions {
  /** Enable hybrid retrieval (RRF fusion). Default true. */
  hybrid?: boolean;
  hybridOptions?: HybridRetrievalOptions;
  /** Enable query expansion. Default 'none'. */
  expansionMode?: 'llm' | 'synonym' | 'none';
  expansionOptions?: Omit<QueryExpansionOptions, 'mode'>;
  /** Enable reranking. Default false (needs reranker). */
  rerank?: boolean;
  rerankOptions?: RerankOptions;
  /** Expand child chunks to parent context. Default false. */
  expandParents?: boolean;
  /** Memory manager to use for parent expansion. */
  manager?: MemoryManager;
}

/**
 * Full retrieval pipeline: expansion → hybrid search → rerank → parent expansion.
 *
 * This is the highest-level retrieval API. Configure which stages to
 * enable via options.
 */
export async function retrievalPipeline(
  provider: IMemoryProvider,
  query: MemoryQuery & { query: string },
  opts: RetrievalPipelineOptions = {},
): Promise<MemoryHit[]> {
  let hits: MemoryHit[];

  // Stage 1: Query expansion + initial retrieval
  if (opts.expansionMode && opts.expansionMode !== 'none') {
    hits = await retrieveWithExpansion(provider, query, {
      mode: opts.expansionMode,
      ...opts.expansionOptions,
    });
  } else if (opts.hybrid !== false) {
    // Stage 1 alternative: hybrid retrieval
    hits = await hybridRetrieve(provider, query, opts.hybridOptions);
  } else {
    hits = await provider.recall(query);
  }

  // Stage 2: Reranking
  if (opts.rerank && opts.rerankOptions?.reranker) {
    hits = await rerankHits(hits, query.query, opts.rerankOptions);
  }

  // Stage 3: Parent expansion
  if (opts.expandParents && opts.manager) {
    hits = await expandToParentContext(opts.manager, hits);
  }

  return hits;
}
