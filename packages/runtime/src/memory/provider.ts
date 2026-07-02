// @ziner/runtime — memory provider
//
// Default `IMemoryProvider` implementation backed by:
//   - append-only JSONL file for durability
//   - in-memory index for fast reads / keyword search
//   - pluggable `IVectorStore` for semantic recall
//   - pluggable `IEmbeddingProvider` for vector generation
//
// This is the production default for local deployments. Cloud / team
// deployments can swap in a provider that talks to a remote vector DB.

import { promises as fsp, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import type {
  IMemoryProvider,
  IEmbeddingProvider,
  MemoryRecord,
  MemoryQuery,
  MemoryHit,
  MemoryHitReason,
  MemoryListFilter,
  MemoryPurgeFilter,
} from '@ziner/contracts';
import type { IVectorStore, VectorRecord } from '../storage/vector-store';
import { createInMemoryVectorStore } from '../storage/vector-store';
import { createLocalEmbeddingProvider } from '../embedding';
import { newMemoryId, matchMemoryRecord, matchPurgeFilter, keywordScore } from './types';

const COMPACT_AFTER_TOMBSTONES = 100;

export interface JsonlMemoryProviderOptions {
  /** Root directory for the JSONL file; created if missing. */
  rootDir: string;
  /** Embedding provider; default local deterministic embedding. */
  embedding?: IEmbeddingProvider;
  /** Vector store backend; default in-memory store. */
  vectorStore?: IVectorStore;
  /** Filename for the memory log; default 'memories.jsonl'. */
  memoriesFile?: string;
  /**
   * Max number of records for which keyword fallback is performed in recall().
   * Above this threshold only vector search is used. Default 1000.
   */
  keywordFallbackThreshold?: number;
}

async function ensureDir(p: string): Promise<void> {
  if (!existsSync(p)) await fsp.mkdir(p, { recursive: true });
}

/** TTL + LRU cache for query embeddings to avoid recomputing the same query. */
class QueryEmbeddingCache {
  private readonly store = new Map<string, { vector: number[]; expires: number }>();
  constructor(
    private readonly ttlMs: number,
    private readonly maxSize = 500,
  ) {}
  get(query: string): number[] | undefined {
    const key = query.toLowerCase().trim().slice(0, 200);
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expires) {
      this.store.delete(key);
      return undefined;
    }
    // LRU: re-insert to move to end (most recently used)
    this.store.delete(key);
    this.store.set(key, entry);
    return entry.vector;
  }
  set(query: string, vector: number[]): void {
    const key = query.toLowerCase().trim().slice(0, 200);
    // Enforce max size: evict oldest (first inserted) entries
    if (this.store.size >= this.maxSize) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
    this.store.set(key, { vector, expires: Date.now() + this.ttlMs });
  }
  clear(): void {
    this.store.clear();
  }
  get size(): number {
    return this.store.size;
  }
}

async function readJsonl<T>(file: string): Promise<T[]> {
  if (!existsSync(file)) return [];
  const text = await fsp.readFile(file, 'utf8');
  if (!text) return [];
  const out: T[] = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // skip malformed
    }
  }
  return out;
}

async function atomicAppend(file: string, line: string): Promise<void> {
  await ensureDir(dirname(file));
  await fsp.appendFile(file, line + '\n', 'utf8');
}

function isTombstone(r: MemoryRecord | { __deleted: true; id: string }): r is { __deleted: true; id: string } {
  return (r as { __deleted?: boolean }).__deleted === true;
}

function tokenSet(content?: string): Set<string> {
  return new Set((content ?? '').toLowerCase().split(/\W+/).filter(Boolean));
}

/** Default production memory provider for V2. */
export class JsonlMemoryProvider implements IMemoryProvider {
  readonly name = 'jsonl-memory-provider';

  private readonly file: string;
  private readonly embedding: IEmbeddingProvider;
  private readonly vectors: IVectorStore;
  private readonly records = new Map<string, MemoryRecord>();
  private readonly keywordFallbackThreshold: number;
  private readonly contentTokens = new Map<string, Set<string>>();
  private readonly queryEmbeddingCache: QueryEmbeddingCache;
  private writeChain: Promise<void> = Promise.resolve();
  private loaded = false;
  private tombstoneCount = 0;

  constructor(opts: JsonlMemoryProviderOptions) {
    this.file = join(opts.rootDir, opts.memoriesFile ?? 'memories.jsonl');
    this.embedding = opts.embedding ?? createLocalEmbeddingProvider();
    this.vectors = opts.vectorStore ?? createInMemoryVectorStore();
    this.keywordFallbackThreshold = opts.keywordFallbackThreshold ?? 1000;
    this.queryEmbeddingCache = new QueryEmbeddingCache(5 * 60 * 1000);
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    const rows = await readJsonl<MemoryRecord | { __deleted: true; id: string }>(this.file);
    const toUpsert: VectorRecord[] = [];
    for (const r of rows) {
      if (isTombstone(r)) {
        this.records.delete(r.id);
        this.contentTokens.delete(r.id);
        await this.vectors.delete(r.id).catch(() => undefined);
      } else {
        this.records.set(r.id, r);
        this.contentTokens.set(r.id, tokenSet(r.content));
        if (r.vector && !r.deleted) {
          toUpsert.push(vectorRecordFromMemory(r));
        }
      }
    }
    // Batch-upsert in parallel to avoid N sequential vector-store round trips.
    if (toUpsert.length) {
      await Promise.all(toUpsert.map((v) => this.vectors.upsert(v)));
    }
    this.loaded = true;
  }

  private async persist(record: MemoryRecord): Promise<void> {
    this.writeChain = this.writeChain
      .then(() => atomicAppend(this.file, JSON.stringify(record)))
      .catch((err) => {
        console.error('[JsonlMemoryProvider] persist error:', err);
      });
    await this.writeChain;
  }

  private async tombstone(id: string): Promise<void> {
    this.writeChain = this.writeChain
      .then(() => atomicAppend(this.file, JSON.stringify({ __deleted: true, id })))
      .catch((err) => {
        console.error('[JsonlMemoryProvider] tombstone error:', err);
      });
    this.tombstoneCount++;
    await this.writeChain;
    if (this.tombstoneCount >= COMPACT_AFTER_TOMBSTONES) {
      await this.compact();
    }
  }

  private async compact(): Promise<void> {
    const tmpFile = `${this.file}.tmp`;
    const lines: string[] = [];
    for (const r of this.records.values()) {
      if (!r.deleted) lines.push(JSON.stringify(r));
    }
    await fsp.writeFile(tmpFile, lines.join('\n') + (lines.length ? '\n' : ''), 'utf8');
    await fsp.rename(tmpFile, this.file);
    this.tombstoneCount = 0;
  }

  async store(record: MemoryRecord): Promise<MemoryRecord> {
    await this.load();
    const rec: MemoryRecord = {
      ...record,
      id: record.id || newMemoryId(),
      createdAt: record.createdAt || Date.now(),
    };
    if (!rec.vector && rec.content) {
      rec.vector = await this.embedding.embed(rec.content);
    }

    // Deduplication: check for near-duplicate memories of the same kind/scope
    // If a highly similar memory exists (>0.88), update it instead of inserting a new one.
    // Short memories (<= 20 chars) use exact-match deduplication for speed and accuracy.
    if (rec.content) {
      const shortContent = rec.content.length <= 20;
      const threshold = shortContent ? 0.98 : 0.88;
      const similar = await this._findSimilar(rec, threshold);
      if (similar) {
        const existing = this.records.get(similar.id);
        if (existing) {
          const merged: MemoryRecord = {
            ...existing,
            content: rec.content.length >= existing.content.length ? rec.content : existing.content,
            importance: Math.max(this._effectiveImportance(existing), rec.importance ?? 0.5),
            accessedAt: Date.now(),
            vector: rec.vector,
            payload: { ...existing.payload, ...rec.payload, duplicateCount: ((existing.payload as Record<string, unknown>)?.duplicateCount as number ?? 0) + 1 },
          };
          this.records.set(existing.id, merged);
          this.contentTokens.set(existing.id, tokenSet(merged.content));
          await this.vectors.upsert(vectorRecordFromMemory(merged));
          await this.persist(merged);
          return merged;
        }
      }
    }

    this.records.set(rec.id, rec);
    this.contentTokens.set(rec.id, tokenSet(rec.content));
    await this.vectors.upsert(vectorRecordFromMemory(rec));
    await this.persist(rec);
    return rec;
  }

  /**
   * Calculate effective importance considering decay over time.
   * Memories that haven't been accessed in a long time gradually lose importance.
   * Uses a 30-day half-life for importance decay.
   */
  private _effectiveImportance(rec: MemoryRecord): number {
    const baseImportance = rec.importance ?? 0.5;
    const lastActive = rec.accessedAt ?? rec.createdAt;
    const ageMs = Date.now() - lastActive;
    const IMPORTANCE_HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
    const decayFactor = Math.pow(0.5, ageMs / IMPORTANCE_HALF_LIFE_MS);
    // Decay at most 60% of the original importance (floor at 40%)
    const decayed = baseImportance * (0.4 + 0.6 * decayFactor);
    return Math.max(0.1, Math.min(1.0, decayed));
  }

  /**
   * Find a memory record that is highly similar to the given one.
   * Uses both vector similarity and keyword overlap for accuracy.
   * Returns the id and score of the best match, or null if none above threshold.
   */
  private async _findSimilar(rec: MemoryRecord, threshold: number): Promise<{ id: string; score: number } | null> {
    if (!rec.vector) return null;

    const vectorHits = await this.vectors.query({
      vector: rec.vector,
      topK: 5,
      minScore: threshold * 0.85,
      kind: rec.kind ? [rec.kind] : undefined,
      scope: rec.scope ? [rec.scope] : undefined,
      userId: rec.userId,
    });

    if (vectorHits.length === 0) return null;

    const recTokens = tokenSet(rec.content);
    let best: { id: string; score: number } | null = null;

    for (const vh of vectorHits) {
      if (vh.id === rec.id) continue;
      const existing = this.records.get(vh.id);
      if (!existing || existing.deleted) continue;
      if (existing.kind !== rec.kind) continue;
      if (existing.scope !== rec.scope) continue;

      // Keyword overlap check (cheap second opinion)
      const existingTokens = this.contentTokens.get(vh.id) ?? tokenSet(existing.content);
      let overlap = 0;
      for (const t of recTokens) {
        if (existingTokens.has(t)) overlap++;
      }
      const totalUnique = recTokens.size + existingTokens.size - overlap;
      const jaccard = totalUnique > 0 ? overlap / totalUnique : 0;

      // Hybrid score: weighted average of vector similarity and Jaccard
      const hybridScore = vh.score * 0.7 + jaccard * 0.3;
      if (hybridScore >= threshold && (!best || hybridScore > best.score)) {
        best = { id: vh.id, score: hybridScore };
      }
    }

    return best;
  }

  async recall(q: MemoryQuery): Promise<MemoryHit[]> {
    await this.load();
    const limit = q.limit ?? 10;
    const minScore = q.minScore ?? 0.55;
    const now = Date.now();

    // 1) Vector candidates
    let queryVector = this.queryEmbeddingCache.get(q.query);
    if (!queryVector) {
      queryVector = await this.embedding.embed(q.query);
      this.queryEmbeddingCache.set(q.query, queryVector);
    }
    const vectorHits = await this.vectors.query({
      vector: queryVector,
      topK: limit * 4,
      minScore: minScore * 0.8,
      kind: q.kind,
      scope: q.scope,
      userId: q.userId,
      sessionId: q.sessionId,
      agentName: q.agentName,
      projectId: q.projectId,
      runId: q.runId,
    });

    const hits = new Map<string, MemoryHit>();
    for (const vh of vectorHits) {
      const rec = this.records.get(vh.id);
      if (!rec || rec.deleted) continue;
      if (!matchesFilters(rec, q)) continue;
      const reasons: MemoryHitReason[] = [{ type: 'vector', score: vh.score }];
      hits.set(rec.id, { memory: rec, score: vh.score, reasons });
    }

    // 2) Keyword fallback for small corpora or when vector misses.
    // Only run when the corpus is small enough to keep latency predictable.
    if (hits.size < limit && this.records.size <= this.keywordFallbackThreshold) {
      for (const rec of this.records.values()) {
        if (rec.deleted) continue;
        if (!matchesFilters(rec, q)) continue;
        if (hits.has(rec.id)) continue;
        const tokens = this.contentTokens.get(rec.id) ?? tokenSet(rec.content);
        const kw = keywordScore(q.query, tokens);
        if (kw > 0.2) {
          const score = kw * 0.9;
          hits.set(rec.id, {
            memory: rec,
            score,
            reasons: [{ type: 'keyword', score: kw }],
          });
        }
      }
    }

    // 3) Hybrid re-ranking: combine relevance + recency + importance
    // Recency uses exponential decay with a 7-day half-life.
    // Importance boosts high-value memories.
    const HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
    const ranked: MemoryHit[] = [];

    for (const hit of hits.values()) {
      const rec = hit.memory;

      // Recency score: 1.0 for brand-new, decays to 0.5 at half-life
      const lastActive = rec.accessedAt ?? rec.createdAt;
      const ageMs = now - lastActive;
      const recencyScore = Math.pow(0.5, ageMs / HALF_LIFE_MS);
      // Scale recency to [0.85, 1.0] range as a multiplier (subtle but meaningful)
      const recencyMultiplier = 0.85 + recencyScore * 0.15;

      // Importance score: boost high-importance memories (with time decay)
      const importance = this._effectiveImportance(rec);
      const importanceMultiplier = 0.9 + importance * 0.2; // 0.9 ~ 1.1

      // Combined final score
      const finalScore = hit.score * recencyMultiplier * importanceMultiplier;

      const reasons = [...hit.reasons];
      reasons.push({ type: 'time', score: recencyScore, detail: `recency boost ${(recencyMultiplier - 1).toFixed(3)}` });
      reasons.push({ type: 'kind', score: importance, detail: `importance boost ${(importanceMultiplier - 1).toFixed(3)}` });

      ranked.push({
        memory: rec,
        score: finalScore,
        reasons,
      });
    }

    // 4) Sort by final score and trim
    const sorted = ranked.sort((a, b) => b.score - a.score).slice(0, limit);

    // 5) Update accessedAt (best-effort, async without awaiting)
    for (const h of sorted) {
      h.memory.accessedAt = now;
    }
    return sorted;
  }

  async list(filter: MemoryListFilter = {}): Promise<MemoryRecord[]> {
    await this.load();
    let records = [...this.records.values()].filter((r) => matchMemoryRecord(r, filter));
    records.sort((a, b) => b.createdAt - a.createdAt);
    const offset = filter.offset ?? 0;
    const limit = filter.limit ?? 200;
    return records.slice(offset, offset + limit);
  }

  async get(id: string): Promise<MemoryRecord | undefined> {
    await this.load();
    const rec = this.records.get(id);
    return rec && !rec.deleted ? rec : undefined;
  }

  async delete(id: string): Promise<boolean> {
    await this.load();
    const rec = this.records.get(id);
    if (!rec) return false;
    rec.deleted = true;
    this.records.set(id, rec);
    this.contentTokens.delete(id);
    await this.vectors.delete(id);
    await this.tombstone(id);
    return true;
  }

  async purge(filter: MemoryPurgeFilter): Promise<number> {
    await this.load();
    let count = 0;
    for (const [id, r] of this.records.entries()) {
      if (matchPurgeFilter(r, filter)) {
        this.records.delete(id);
        this.contentTokens.delete(id);
        await this.vectors.delete(id);
        await this.tombstone(id);
        count++;
      }
    }
    return count;
  }

  async count(filter: MemoryListFilter = {}): Promise<number> {
    await this.load();
    return [...this.records.values()].filter((r) => matchMemoryRecord(r, filter)).length;
  }

  async close(): Promise<void> {
    await this.vectors.close();
    this.records.clear();
    this.loaded = false;
  }
}

function vectorRecordFromMemory(r: MemoryRecord): VectorRecord {
  return {
    id: r.id,
    vector: r.vector ?? [],
    kind: r.kind,
    scope: r.scope,
    userId: r.userId,
    sessionId: r.sessionId,
    agentName: r.agentName,
    projectId: r.projectId,
    runId: r.runId,
    createdAt: r.createdAt,
    deleted: r.deleted,
    content: r.content,
  };
}

function matchesFilters(r: MemoryRecord, q: MemoryQuery): boolean {
  if (q.kind) {
    const kinds = Array.isArray(q.kind) ? q.kind : [q.kind];
    if (!kinds.includes(r.kind)) return false;
  }
  if (q.scope) {
    const scopes = Array.isArray(q.scope) ? q.scope : [q.scope];
    if (!scopes.includes(r.scope)) return false;
  }
  if (q.userId !== undefined && r.userId !== q.userId) return false;
  if (q.sessionId !== undefined && r.sessionId !== q.sessionId) return false;
  if (q.agentName !== undefined && r.agentName !== q.agentName) return false;
  if (q.projectId !== undefined && r.projectId !== q.projectId) return false;
  if (q.runId !== undefined && r.runId !== q.runId) return false;
  return true;
}

/** Factory for the default JSONL-backed memory provider. */
export function createJsonlMemoryProvider(opts: JsonlMemoryProviderOptions): IMemoryProvider {
  return new JsonlMemoryProvider(opts);
}
