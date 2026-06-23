// @z-assistant/runtime — memory provider
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
} from '@z-assistant/contracts';
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

/** Tiny TTL cache for query embeddings to avoid recomputing the same query. */
class QueryEmbeddingCache {
  private readonly store = new Map<string, { vector: number[]; expires: number }>();
  constructor(private readonly ttlMs: number) {}
  get(query: string): number[] | undefined {
    const key = query.toLowerCase().trim().slice(0, 200);
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expires) {
      this.store.delete(key);
      return undefined;
    }
    return entry.vector;
  }
  set(query: string, vector: number[]): void {
    const key = query.toLowerCase().trim().slice(0, 200);
    this.store.set(key, { vector, expires: Date.now() + this.ttlMs });
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
    this.records.set(rec.id, rec);
    this.contentTokens.set(rec.id, tokenSet(rec.content));
    await this.vectors.upsert(vectorRecordFromMemory(rec));
    await this.persist(rec);
    return rec;
  }

  async recall(q: MemoryQuery): Promise<MemoryHit[]> {
    await this.load();
    const limit = q.limit ?? 10;
    const minScore = q.minScore ?? 0.55;

    // 1) Vector candidates
    let queryVector = this.queryEmbeddingCache.get(q.query);
    if (!queryVector) {
      queryVector = await this.embedding.embed(q.query);
      this.queryEmbeddingCache.set(q.query, queryVector);
    }
    const vectorHits = await this.vectors.query({
      vector: queryVector,
      topK: limit * 4,
      minScore,
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

    // 3) Sort and trim
    const sorted = [...hits.values()].sort((a, b) => b.score - a.score).slice(0, limit);

    // 4) Update accessedAt (best-effort)
    for (const h of sorted) {
      h.memory.accessedAt = Date.now();
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
