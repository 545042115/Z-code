// @z-assistant/runtime — vector store
//
// Pluggable vector storage abstraction. The default `InMemoryVectorStore`
// keeps everything in-process and is suitable for unit tests, demos, and
// small local deployments. Future backends (LanceDB, ChromaDB, FAISS,
// Pinecone) implement the same `IVectorStore` interface and can be
// swapped in by changing the factory call.

import type { MemoryKind, MemoryScope } from '@z-assistant/contracts';

export interface VectorRecord {
  id: string;
  vector: number[];
  kind: MemoryKind;
  scope: MemoryScope;
  userId: string;
  sessionId?: string;
  agentName?: string;
  projectId?: string;
  runId?: string;
  createdAt: number;
  deleted?: boolean;
  /** Reference back to the original memory content for diagnostics. */
  content?: string;
}

export interface VectorQuery {
  vector: number[];
  topK?: number;
  minScore?: number;
  kind?: MemoryKind | MemoryKind[];
  scope?: MemoryScope | MemoryScope[];
  userId?: string;
  sessionId?: string;
  agentName?: string;
  projectId?: string;
  runId?: string;
}

export interface VectorHit {
  id: string;
  score: number;
  record: VectorRecord;
}

export interface VectorPurgeFilter {
  userId: string;
  kind?: MemoryKind | MemoryKind[];
  scope?: MemoryScope | MemoryScope[];
  sessionId?: string;
  agentName?: string;
  projectId?: string;
  before?: number;
}

export interface IVectorStore {
  readonly name: string;

  /** Insert or update a vector record. */
  upsert(record: VectorRecord): Promise<void>;

  /** Query the store for nearest neighbors. */
  query(q: VectorQuery): Promise<VectorHit[]>;

  /** Soft-delete a record by id. */
  delete(id: string): Promise<boolean>;

  /** Hard-delete records matching the filter. */
  purge(filter: VectorPurgeFilter): Promise<number>;

  /** Count records matching the filter (excluding soft-deleted by default). */
  count(filter?: Partial<VectorPurgeFilter>): Promise<number>;

  /** Release resources. */
  close(): Promise<void>;
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

function matchesKind(kind: MemoryKind, filter?: MemoryKind | MemoryKind[]): boolean {
  if (!filter) return true;
  if (Array.isArray(filter)) return filter.includes(kind);
  return kind === filter;
}

function matchesScope(scope: MemoryScope, filter?: MemoryScope | MemoryScope[]): boolean {
  if (!filter) return true;
  if (Array.isArray(filter)) return filter.includes(scope);
  return scope === filter;
}

function matchesFilter(r: VectorRecord, filter?: Partial<VectorPurgeFilter>): boolean {
  if (!filter) return true;
  if (filter.userId !== undefined && r.userId !== filter.userId) return false;
  if (filter.kind !== undefined && !matchesKind(r.kind, filter.kind)) return false;
  if (filter.scope !== undefined && !matchesScope(r.scope, filter.scope)) return false;
  if (filter.sessionId !== undefined && r.sessionId !== filter.sessionId) return false;
  if (filter.agentName !== undefined && r.agentName !== filter.agentName) return false;
  if (filter.projectId !== undefined && r.projectId !== filter.projectId) return false;
  if (filter.before !== undefined && r.createdAt >= filter.before) return false;
  return true;
}

/**
 * In-memory vector store with cosine-similarity brute-force search.
 * Performs well up to tens of thousands of records; for larger corpora,
 * swap in an HNSW-backed store.
 */
export class InMemoryVectorStore implements IVectorStore {
  readonly name = 'in-memory-vector-store';
  private readonly records = new Map<string, VectorRecord>();

  async upsert(record: VectorRecord): Promise<void> {
    this.records.set(record.id, record);
  }

  async query(q: VectorQuery): Promise<VectorHit[]> {
    const topK = q.topK ?? 10;
    const minScore = q.minScore ?? 0;
    const results: VectorHit[] = [];

    for (const r of this.records.values()) {
      if (r.deleted) continue;
      if (r.vector.length !== q.vector.length) continue;
      if (!matchesKind(r.kind, q.kind)) continue;
      if (!matchesScope(r.scope, q.scope)) continue;
      if (q.userId !== undefined && r.userId !== q.userId) continue;
      if (q.sessionId !== undefined && r.sessionId !== q.sessionId) continue;
      if (q.agentName !== undefined && r.agentName !== q.agentName) continue;
      if (q.projectId !== undefined && r.projectId !== q.projectId) continue;
      if (q.runId !== undefined && r.runId !== q.runId) continue;

      const score = cosineSimilarity(q.vector, r.vector);
      if (score < minScore) continue;
      results.push({ id: r.id, score, record: r });
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topK);
  }

  async delete(id: string): Promise<boolean> {
    const r = this.records.get(id);
    if (!r) return false;
    this.records.set(id, { ...r, deleted: true });
    return true;
  }

  async purge(filter: VectorPurgeFilter): Promise<number> {
    let count = 0;
    for (const [id, r] of this.records.entries()) {
      if (matchesFilter(r, filter)) {
        this.records.delete(id);
        count++;
      }
    }
    return count;
  }

  async count(filter?: Partial<VectorPurgeFilter>): Promise<number> {
    let count = 0;
    for (const r of this.records.values()) {
      if (r.deleted) continue;
      if (matchesFilter(r, filter)) count++;
    }
    return count;
  }

  async close(): Promise<void> {
    this.records.clear();
  }
}

/** Factory for the default in-memory vector store. */
export function createInMemoryVectorStore(): IVectorStore {
  return new InMemoryVectorStore();
}
