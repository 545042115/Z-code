// @ziner/runtime — SQLite-backed memory provider
//
// Drop-in replacement for JsonlMemoryProvider with better performance
// and smaller memory footprint. Uses SQLite for structured queries
// and optional FTS5 for keyword search.
//
// Compatible with Windows / Linux / macOS (via better-sqlite3).
// Android / iOS will use their native SQLite stacks with the same schema.

import { existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import Database from 'better-sqlite3';
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
import { createLocalEmbeddingProvider, withEmbeddingCache } from '../embedding/index';
import { newMemoryId, matchMemoryRecord, matchPurgeFilter, keywordScore } from './types';

const SCHEMA_VERSION = 1;

export interface SqliteMemoryProviderOptions {
  /** Root directory for the SQLite database; created if missing. */
  rootDir: string;
  /** Embedding provider; default local deterministic embedding. */
  embedding?: IEmbeddingProvider;
  /**
   * Vector dimensions for the default local embedding provider.
   * Ignored if a custom `embedding` provider is supplied.
   * Default: 384. Lower values (e.g. 128) reduce memory usage at the cost of accuracy.
   */
  embeddingDimensions?: number;
  /**
   * Vector store backend; default in-memory store loaded from DB on init.
   * When an external store is supplied, this provider only manages
   * metadata and keyword search — vectors are delegated.
   */
  vectorStore?: IVectorStore;
  /** Database filename; default 'memories.db'. */
  dbFile?: string;
  /**
   * Enable FTS5 for keyword search. Default true.
   * Disable if your SQLite build doesn't include FTS5.
   */
  enableFts?: boolean;
  /**
   * Max number of records for which keyword fallback is performed in recall().
   * Above this threshold only vector search is used. Default 2000.
   */
  keywordFallbackThreshold?: number;
  /**
   * WAL mode for better concurrency and write performance. Default true.
   */
  walMode?: boolean;
  /**
   * Max number of memories before LRU eviction. 0 = unlimited. Default 0 (unlimited).
   * When exceeded, the least-recently-accessed memories are soft-deleted.
   */
  maxMemories?: number;
  /**
   * Time-to-live in ms. Memories older than this (and not accessed recently)
   * are soft-deleted. 0 = disabled. Default 0 (disabled).
   */
  ttlMs?: number;
  /**
   * Enable embedding cache to speed up repeated queries. Default true.
   * Disable if memory usage is a concern and queries are rarely repeated.
   */
  enableEmbeddingCache?: boolean;
  /**
   * Maximum number of embeddings to cache. Default 500.
   * Only used when `enableEmbeddingCache` is true.
   */
  embeddingCacheSize?: number;
  /**
   * Compress memories older than this (ms) by generating an extractive summary.
   * 0 = disabled. Default 0 (disabled).
   *
   * Compression reduces memory/disk usage while preserving keyword searchability.
   * The original embedding vector is kept so vector recall quality is unaffected.
   */
  compressAfterMs?: number;
  /**
   * Target compressed length as a fraction of original (0-1). Default 0.3.
   * Only used when `compressAfterMs` is set.
   */
  compressionRatio?: number;
}

function ensureDir(p: string): void {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

function tokenSet(content?: string): Set<string> {
  return new Set((content ?? '').toLowerCase().split(/\W+/).filter(Boolean));
}

/**
 * SQLite-backed memory provider.
 *
 * Stores memory records in a SQLite database with:
 * - Structured queries (by kind, scope, userId, etc.)
 * - Optional FTS5 full-text search for keyword matching
 * - Vector search (delegated to IVectorStore, default in-memory)
 * - Deduplication on write (same logic as JsonlMemoryProvider)
 */
export class SqliteMemoryProvider implements IMemoryProvider {
  readonly name = 'sqlite-memory-provider';

  private readonly db: Database.Database;
  private readonly embedding: IEmbeddingProvider;
  private readonly vectors: IVectorStore;
  private readonly keywordFallbackThreshold: number;
  private readonly enableFts: boolean;
  private readonly maxMemories: number;
  private readonly ttlMs: number;
  private readonly compressAfterMs: number;
  private readonly compressionRatio: number;
  private readonly contentTokens = new Map<string, Set<string>>();
  private loaded = false;
  private lastEvictionCheck = 0;
  private lastCompressionCheck = 0;

  constructor(opts: SqliteMemoryProviderOptions) {
    ensureDir(opts.rootDir);
    const dbPath = join(opts.rootDir, opts.dbFile ?? 'memories.db');
    ensureDir(dirname(dbPath));

    this.db = new Database(dbPath);
    let emb = opts.embedding ?? createLocalEmbeddingProvider({
      dimensions: opts.embeddingDimensions ?? 384,
    });
    if (opts.enableEmbeddingCache !== false) {
      emb = withEmbeddingCache(emb, { maxCacheSize: opts.embeddingCacheSize ?? 500 });
    }
    this.embedding = emb;
    this.vectors = opts.vectorStore ?? createInMemoryVectorStore();
    this.keywordFallbackThreshold = opts.keywordFallbackThreshold ?? 2000;
    this.enableFts = opts.enableFts ?? true;
    this.maxMemories = opts.maxMemories ?? 0;
    this.ttlMs = opts.ttlMs ?? 0;
    this.compressAfterMs = opts.compressAfterMs ?? 0;
    this.compressionRatio = Math.max(0.1, Math.min(0.9, opts.compressionRatio ?? 0.3));

    if (opts.walMode !== false) {
      this.db.pragma('journal_mode = WAL');
    }
    this.db.pragma('foreign_keys = ON');
  }

  // ── Schema management ──────────────────────────────────────────────

  /** Initialize the database schema. Safe to call multiple times. */
  async initialize(): Promise<void> {
    await this.ensureSchema();
  }

  private async ensureSchema(): Promise<void> {
    if (this.loaded) return;

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        kind TEXT NOT NULL,
        scope TEXT NOT NULL,
        userId TEXT NOT NULL DEFAULT '',
        sessionId TEXT,
        agentName TEXT,
        projectId TEXT,
        runId TEXT,
        importance REAL NOT NULL DEFAULT 0.5,
        createdAt INTEGER NOT NULL,
        accessedAt INTEGER,
        deleted INTEGER NOT NULL DEFAULT 0,
        payload TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_memories_userId ON memories(userId);
      CREATE INDEX IF NOT EXISTS idx_memories_kind ON memories(kind);
      CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(scope);
      CREATE INDEX IF NOT EXISTS idx_memories_createdAt ON memories(createdAt DESC);
      CREATE INDEX IF NOT EXISTS idx_memories_user_kind ON memories(userId, kind);
      CREATE INDEX IF NOT EXISTS idx_memories_user_scope ON memories(userId, scope);
    `);

    if (this.enableFts) {
      try {
        this.db.exec(`
          CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
            content,
            content='memories',
            content_rowid='rowid',
            tokenize = 'unicode61'
          );

          CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
            INSERT INTO memory_fts(rowid, content) VALUES (new.rowid, new.content);
          END;

          CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
            INSERT INTO memory_fts(memory_fts, rowid, content) VALUES('delete', old.rowid, old.content);
          END;

          CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
            INSERT INTO memory_fts(memory_fts, rowid, content) VALUES('delete', old.rowid, old.content);
            INSERT INTO memory_fts(rowid, content) VALUES (new.rowid, new.content);
          END;
        `);
      } catch {
        // FTS5 not available — fall back to in-memory keyword search
        (this as any).enableFts = false;
      }
    }

    // Set schema version
    const existing = this.db.prepare('SELECT value FROM metadata WHERE key = ?').get('schema_version') as { value: string } | undefined;
    if (!existing) {
      this.db.prepare('INSERT INTO metadata (key, value) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION));
    }

    // Load vectors into the vector store
    await this._loadVectors();

    // Pre-build content token cache for non-FTS keyword search
    if (!this.enableFts) {
      this._rebuildTokenCache();
    }

    this.loaded = true;
  }

  private async _loadVectors(): Promise<void> {
    const rows = this.db.prepare(`
      SELECT id, content, kind, scope, userId, sessionId, agentName, projectId, runId, createdAt, deleted
      FROM memories WHERE deleted = 0
    `).all() as Array<{
      id: string; content: string; kind: any; scope: any; userId: string;
      sessionId?: string; agentName?: string; projectId?: string;
      runId?: string; createdAt: number; deleted: number;
    }>;

    const toUpsert: VectorRecord[] = [];
    for (const row of rows) {
      const vector = await this.embedding.embed(row.content);
      toUpsert.push({
        id: row.id,
        vector,
        kind: row.kind,
        scope: row.scope,
        userId: row.userId,
        sessionId: row.sessionId,
        agentName: row.agentName,
        projectId: row.projectId,
        runId: row.runId,
        createdAt: row.createdAt,
        deleted: !!row.deleted,
        content: row.content,
      });
    }
    if (toUpsert.length) {
      await Promise.all(toUpsert.map((v) => this.vectors.upsert(v)));
    }
  }

  private _rebuildTokenCache(): void {
    this.contentTokens.clear();
    const rows = this.db.prepare('SELECT id, content FROM memories WHERE deleted = 0').all() as Array<{ id: string; content: string }>;
    for (const row of rows) {
      this.contentTokens.set(row.id, tokenSet(row.content));
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────

  private _rowToRecord(row: any): MemoryRecord {
    return {
      id: row.id,
      content: row.content,
      kind: row.kind,
      scope: row.scope,
      userId: row.userId ?? '',
      sessionId: row.sessionId,
      agentName: row.agentName,
      projectId: row.projectId,
      runId: row.runId,
      importance: row.importance ?? 0.5,
      createdAt: row.createdAt,
      accessedAt: row.accessedAt,
      deleted: !!row.deleted,
      payload: row.payload ? JSON.parse(row.payload) : undefined,
    };
  }

  private _recordToRow(rec: MemoryRecord): any[] {
    return [
      rec.id,
      rec.content,
      rec.kind,
      rec.scope,
      rec.userId ?? '',
      rec.sessionId,
      rec.agentName,
      rec.projectId,
      rec.runId,
      rec.importance ?? 0.5,
      rec.createdAt,
      rec.accessedAt,
      rec.deleted ? 1 : 0,
      rec.payload ? JSON.stringify(rec.payload) : null,
    ];
  }

  private _buildFilterWhere(q: MemoryQuery | MemoryListFilter): { sql: string; params: any[] } {
    const conditions: string[] = ['deleted = 0'];
    const params: any[] = [];

    if (q.kind) {
      const kinds = Array.isArray(q.kind) ? q.kind : [q.kind];
      conditions.push(`kind IN (${kinds.map(() => '?').join(', ')})`);
      params.push(...kinds);
    }
    if (q.scope) {
      const scopes = Array.isArray(q.scope) ? q.scope : [q.scope];
      conditions.push(`scope IN (${scopes.map(() => '?').join(', ')})`);
      params.push(...scopes);
    }
    if (q.userId !== undefined) {
      conditions.push('userId = ?');
      params.push(q.userId);
    }
    if ((q as any).sessionId !== undefined) {
      conditions.push('sessionId = ?');
      params.push((q as any).sessionId);
    }
    if ((q as any).agentName !== undefined) {
      conditions.push('agentName = ?');
      params.push((q as any).agentName);
    }
    if ((q as any).projectId !== undefined) {
      conditions.push('projectId = ?');
      params.push((q as any).projectId);
    }
    if ((q as any).runId !== undefined) {
      conditions.push('runId = ?');
      params.push((q as any).runId);
    }

    return { sql: conditions.join(' AND '), params };
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
    const IMPORTANCE_HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000;
    const decayFactor = Math.pow(0.5, ageMs / IMPORTANCE_HALF_LIFE_MS);
    const decayed = baseImportance * (0.4 + 0.6 * decayFactor);
    return Math.max(0.1, Math.min(1.0, decayed));
  }

  /**
   * Find a memory record that is highly similar to the given one.
   * Uses both vector similarity and keyword overlap for accuracy.
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
      const existingRow = this.db.prepare('SELECT * FROM memories WHERE id = ? AND deleted = 0').get(vh.id);
      if (!existingRow) continue;
      const existing = this._rowToRecord(existingRow);
      if (existing.kind !== rec.kind) continue;
      if (existing.scope !== rec.scope) continue;

      const existingTokens = this.contentTokens.get(vh.id) ?? tokenSet(existing.content);
      let overlap = 0;
      for (const t of recTokens) {
        if (existingTokens.has(t)) overlap++;
      }
      const totalUnique = recTokens.size + existingTokens.size - overlap;
      const jaccard = totalUnique > 0 ? overlap / totalUnique : 0;

      const hybridScore = vh.score * 0.7 + jaccard * 0.3;
      if (hybridScore >= threshold && (!best || hybridScore > best.score)) {
        best = { id: vh.id, score: hybridScore };
      }
    }

    return best;
  }

  // ── Public API (IMemoryProvider) ───────────────────────────────────

  async store(record: MemoryRecord): Promise<MemoryRecord> {
    await this.ensureSchema();

    const rec: MemoryRecord = {
      ...record,
      id: record.id || newMemoryId(),
      createdAt: record.createdAt || Date.now(),
    };
    if (!rec.vector && rec.content) {
      rec.vector = await this.embedding.embed(rec.content);
    }

    // Deduplication: check for near-duplicate memories of the same kind/scope
    if (rec.content) {
      const shortContent = rec.content.length <= 20;
      const threshold = shortContent ? 0.98 : 0.88;
      const similar = await this._findSimilar(rec, threshold);
      if (similar) {
        const existingRow = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(similar.id);
        if (existingRow) {
          const existing = this._rowToRecord(existingRow);
          const merged: MemoryRecord = {
            ...existing,
            content: rec.content.length >= existing.content.length ? rec.content : existing.content,
            importance: Math.max(this._effectiveImportance(existing), rec.importance ?? 0.5),
            accessedAt: Date.now(),
            vector: rec.vector,
            payload: { ...existing.payload, ...rec.payload, duplicateCount: ((existing.payload as Record<string, unknown>)?.duplicateCount as number ?? 0) + 1 },
          };

          this.db.prepare(`
            UPDATE memories SET
              content = ?, importance = ?, accessedAt = ?, payload = ?
            WHERE id = ?
          `).run(
            merged.content,
            merged.importance,
            merged.accessedAt,
            merged.payload ? JSON.stringify(merged.payload) : null,
            merged.id,
          );

          if (!this.enableFts) {
            this.contentTokens.set(merged.id, tokenSet(merged.content));
          }

          await this.vectors.upsert({
            id: merged.id,
            vector: merged.vector ?? [],
            kind: merged.kind,
            scope: merged.scope,
            userId: merged.userId ?? '',
            sessionId: merged.sessionId,
            agentName: merged.agentName,
            projectId: merged.projectId,
            runId: merged.runId,
            createdAt: merged.createdAt,
            deleted: !!merged.deleted,
            content: merged.content,
          });

          return merged;
        }
      }
    }

    // Insert or replace
    const existing = this.db.prepare('SELECT id FROM memories WHERE id = ?').get(rec.id);
    if (existing) {
      const row = this._recordToRow(rec);
      // row order: id, content, kind, scope, userId, sessionId, agentName, projectId, runId, importance, createdAt, accessedAt, deleted, payload
      // update needs: content, kind, scope, userId, sessionId, agentName, projectId, runId, importance, createdAt, accessedAt, deleted, payload, id
      this.db.prepare(`
        UPDATE memories SET
          content = ?, kind = ?, scope = ?, userId = ?,
          sessionId = ?, agentName = ?, projectId = ?, runId = ?,
          importance = ?, createdAt = ?, accessedAt = ?, deleted = ?, payload = ?
        WHERE id = ?
      `).run(...row.slice(1), row[0]);
    } else {
      this.db.prepare(`
        INSERT INTO memories (
          id, content, kind, scope, userId,
          sessionId, agentName, projectId, runId,
          importance, createdAt, accessedAt, deleted, payload
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(...this._recordToRow(rec));
    }

    if (!this.enableFts) {
      this.contentTokens.set(rec.id, tokenSet(rec.content));
    }

    await this.vectors.upsert({
      id: rec.id,
      vector: rec.vector ?? [],
      kind: rec.kind,
      scope: rec.scope,
      userId: rec.userId ?? '',
      sessionId: rec.sessionId,
      agentName: rec.agentName,
      projectId: rec.projectId,
      runId: rec.runId,
      createdAt: rec.createdAt,
      deleted: !!rec.deleted,
      content: rec.content,
    });

    // Evict if needed (LRU + TTL)
    this._maybeRunEviction();

    return rec;
  }

  async recall(q: MemoryQuery): Promise<MemoryHit[]> {
    await this.ensureSchema();
    await this._maybeRunEviction();
    const limit = q.limit ?? 10;
    const minScore = q.minScore ?? 0.55;
    const now = Date.now();

    // 1) Vector candidates
    let queryVector: number[];
    try {
      // Try to compute embedding — if it fails, fall back to keyword only
      queryVector = await this.embedding.embed(q.query);
    } catch {
      queryVector = [];
    }

    const hits = new Map<string, MemoryHit>();

    if (queryVector.length > 0) {
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

      for (const vh of vectorHits) {
        const row = this.db.prepare('SELECT * FROM memories WHERE id = ? AND deleted = 0').get(vh.id);
        if (!row) continue;
        const rec = this._rowToRecord(row);
        if (!matchMemoryRecord(rec, q as MemoryListFilter)) continue;
        const reasons: MemoryHitReason[] = [{ type: 'vector', score: vh.score }];
        hits.set(rec.id, { memory: rec, score: vh.score, reasons });
      }
    }

    // 2) Keyword fallback for small corpora or when vector misses.
    const totalCount = this.db.prepare('SELECT COUNT(*) as cnt FROM memories WHERE deleted = 0').get() as { cnt: number };
    if (hits.size < limit && totalCount.cnt <= this.keywordFallbackThreshold) {
      const { sql, params } = this._buildFilterWhere(q);

      if (this.enableFts) {
        // Use FTS5 for keyword search
        const ftsQuery = q.query.toLowerCase().split(/\s+/).filter(Boolean).join(' OR ');
        if (ftsQuery) {
          try {
            const ftsRows = this.db.prepare(`
              SELECT m.*, bm25(memory_fts) as rank
              FROM memory_fts
              JOIN memories m ON m.rowid = memory_fts.rowid
              WHERE memory_fts MATCH ?
                AND m.${sql}
              ORDER BY rank ASC
              LIMIT ?
            `).all(ftsQuery, ...params, limit * 4) as any[];

            for (const row of ftsRows) {
              if (hits.has(row.id)) continue;
              const rec = this._rowToRecord(row);
              // Convert BM25 rank to a 0-1 score (lower rank = better match)
              const kwScore = Math.max(0.2, Math.min(0.95, 1 / (1 + row.rank)));
              hits.set(row.id, {
                memory: rec,
                score: kwScore * 0.9,
                reasons: [{ type: 'keyword', score: kwScore }],
              });
            }
          } catch {
            // FTS query failed, skip keyword fallback
          }
        }
      } else {
        // Fallback: in-memory keyword search
        const allRows = this.db.prepare(`SELECT * FROM memories WHERE ${sql}`).all(...params) as any[];
        for (const row of allRows) {
          if (hits.has(row.id)) continue;
          const rec = this._rowToRecord(row);
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
    }

    // 3) Hybrid re-ranking: combine relevance + recency + importance
    const HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000;
    const ranked: MemoryHit[] = [];

    for (const hit of hits.values()) {
      const rec = hit.memory;

      const lastActive = rec.accessedAt ?? rec.createdAt;
      const ageMs = now - lastActive;
      const recencyScore = Math.pow(0.5, ageMs / HALF_LIFE_MS);
      const recencyMultiplier = 0.85 + recencyScore * 0.15;

      const importance = this._effectiveImportance(rec);
      const importanceMultiplier = 0.9 + importance * 0.2;

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

    // 5) Update accessedAt (best-effort)
    const updateStmt = this.db.prepare('UPDATE memories SET accessedAt = ? WHERE id = ?');
    const updateMany = this.db.transaction((ids: string[]) => {
      for (const id of ids) updateStmt.run(now, id);
    });
    try {
      updateMany(sorted.map((h) => h.memory.id));
      for (const h of sorted) {
        h.memory.accessedAt = now;
      }
    } catch {
      // ignore
    }

    return sorted;
  }

  async list(filter: MemoryListFilter = {}): Promise<MemoryRecord[]> {
    await this.ensureSchema();
    await this._maybeRunEviction();
    const { sql, params } = this._buildFilterWhere(filter);
    const offset = filter.offset ?? 0;
    const limit = filter.limit ?? 200;

    const rows = this.db.prepare(`
      SELECT * FROM memories
      WHERE ${sql}
      ORDER BY createdAt DESC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as any[];

    return rows.map((r) => this._rowToRecord(r));
  }

  async get(id: string): Promise<MemoryRecord | undefined> {
    await this.ensureSchema();
    const row = this.db.prepare('SELECT * FROM memories WHERE id = ? AND deleted = 0').get(id);
    if (!row) return undefined;
    return this._rowToRecord(row);
  }

  async delete(id: string): Promise<boolean> {
    await this.ensureSchema();
    const existing = this.db.prepare('SELECT id FROM memories WHERE id = ? AND deleted = 0').get(id);
    if (!existing) return false;

    this.db.prepare('UPDATE memories SET deleted = 1 WHERE id = ?').run(id);
    if (!this.enableFts) {
      this.contentTokens.delete(id);
    }
    await this.vectors.delete(id).catch(() => undefined);
    return true;
  }

  async purge(filter: MemoryPurgeFilter): Promise<number> {
    await this.ensureSchema();
    const { sql, params } = this._buildFilterWhere(filter as any);
    const rows = this.db.prepare(`SELECT id FROM memories WHERE ${sql}`).all(...params) as Array<{ id: string }>;

    if (rows.length === 0) return 0;

    const ids = rows.map((r) => r.id);
    this.db.prepare(`UPDATE memories SET deleted = 1 WHERE id IN (${ids.map(() => '?').join(', ')})`).run(...ids);

    for (const id of ids) {
      if (!this.enableFts) this.contentTokens.delete(id);
      await this.vectors.delete(id).catch(() => undefined);
    }

    return ids.length;
  }

  async count(filter?: MemoryListFilter): Promise<number> {
    await this.ensureSchema();
    const f: MemoryListFilter = filter ?? {};
    const { sql, params } = this._buildFilterWhere(f);
    const row = this.db.prepare(`SELECT COUNT(*) as cnt FROM memories WHERE ${sql}`).get(...params) as { cnt: number };
    return row.cnt;
  }

  // ── Eviction (LRU + TTL) ────────────────────────────────────────────

  /**
   * Run eviction if needed. Throttled to at most once per minute.
   * Called automatically after store() and before recall()/list().
   */
  private async _maybeRunEviction(): Promise<void> {
    if (this.maxMemories === 0 && this.ttlMs === 0) return;

    const now = Date.now();
    if (now - this.lastEvictionCheck < 60_000) return; // at most once per minute
    this.lastEvictionCheck = now;

    // TTL eviction: soft-delete memories not accessed within TTL
    if (this.ttlMs > 0) {
      const cutoff = now - this.ttlMs;
      const rows = this.db.prepare(`
        SELECT id FROM memories
        WHERE deleted = 0
          AND COALESCE(accessedAt, createdAt) < ?
      `).all(cutoff) as Array<{ id: string }>;

      if (rows.length > 0) {
        const ids = rows.map((r) => r.id);
        this.db.prepare(`
          UPDATE memories SET deleted = 1
          WHERE id IN (${ids.map(() => '?').join(', ')})
        `).run(...ids);
        for (const id of ids) {
          if (!this.enableFts) this.contentTokens.delete(id);
          await this.vectors.delete(id).catch(() => undefined);
        }
      }
    }

    // LRU eviction: if above maxMemories, evict least-recently-accessed
    if (this.maxMemories > 0) {
      const totalRow = this.db.prepare(
        'SELECT COUNT(*) as cnt FROM memories WHERE deleted = 0',
      ).get() as { cnt: number };

      const excess = totalRow.cnt - this.maxMemories;
      if (excess > 0) {
        const toEvict = this.db.prepare(`
          SELECT id FROM memories
          WHERE deleted = 0
          ORDER BY COALESCE(accessedAt, createdAt) ASC
          LIMIT ?
        `).all(Math.ceil(excess * 1.1)) as Array<{ id: string }>; // evict 10% extra to avoid thrashing

        const ids = toEvict.map((r) => r.id);
        this.db.prepare(`
          UPDATE memories SET deleted = 1
          WHERE id IN (${ids.map(() => '?').join(', ')})
        `).run(...ids);
        for (const id of ids) {
          if (!this.enableFts) this.contentTokens.delete(id);
          await this.vectors.delete(id).catch(() => undefined);
        }
      }
    }

    // Compress old memories in the background
    this._maybeCompressOldMemories();
  }

  /**
   * Generate an extractive summary of a memory by keeping the most
   * informative sentences and key phrases.
   *
   * The original embedding vector is preserved so vector recall quality
   * is not affected by compression.
   */
  private _compressContent(content: string): string {
    if (content.length < 100) return content; // short enough already

    const targetLen = Math.floor(content.length * this.compressionRatio);
    const sentences = content.split(/(?<=[.!?。！？])\s+/).filter((s) => s.trim().length > 0);

    if (sentences.length <= 2) {
      // Too few sentences — just truncate
      return content.slice(0, targetLen) + '…';
    }

    // Score sentences by keyword frequency (extractive summarization)
    const wordFreq = new Map<string, number>();
    const words = content.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
    for (const w of words) {
      if (w.length < 3) continue;
      wordFreq.set(w, (wordFreq.get(w) ?? 0) + 1);
    }

    const scored = sentences.map((sentence, idx) => {
      const sentWords = sentence.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
      let score = 0;
      for (const w of sentWords) {
        score += wordFreq.get(w) ?? 0;
      }
      // Position bias: first and last sentences get a boost
      if (idx === 0) score *= 1.5;
      if (idx === sentences.length - 1) score *= 1.2;
      return { sentence, score, idx };
    });

    // Take highest-scored sentences, preserve original order
    scored.sort((a, b) => b.score - a.score);
    const selected: typeof scored = [];
    let accumulated = 0;

    for (const s of scored) {
      if (accumulated >= targetLen) break;
      selected.push(s);
      accumulated += s.sentence.length;
    }

    selected.sort((a, b) => a.idx - b.idx);
    const summary = selected.map((s) => s.sentence).join(' ');

    return summary.length < content.length ? summary : content;
  }

  /**
   * Compress old memories in the background. Throttled to once per hour.
   */
  private async _maybeCompressOldMemories(): Promise<void> {
    if (this.compressAfterMs === 0) return;

    const now = Date.now();
    if (now - this.lastCompressionCheck < 60 * 60 * 1000) return; // at most once per hour
    this.lastCompressionCheck = now;

    const cutoff = now - this.compressAfterMs;
    const rows = this.db.prepare(`
      SELECT id, content, payload FROM memories
      WHERE deleted = 0
        AND createdAt < ?
        AND COALESCE(accessedAt, 0) < ?
        AND length(content) > 200
      LIMIT 50
    `).all(cutoff, cutoff) as Array<{ id: string; content: string; payload: string | null }>;

    for (const row of rows) {
      const payload = row.payload ? JSON.parse(row.payload) : {};
      if (payload.compressed) continue; // already compressed

      const compressed = this._compressContent(row.content);
      if (compressed.length >= row.content.length) continue; // no benefit

      const newPayload = {
        ...payload,
        compressed: true,
        originalLength: row.content.length,
        compressedAt: now,
      };

      this.db.prepare(`
        UPDATE memories SET content = ?, payload = ?
        WHERE id = ?
      `).run(compressed, JSON.stringify(newPayload), row.id);

      if (!this.enableFts) {
        this.contentTokens.set(row.id, tokenSet(compressed));
      }
      // Note: we keep the original vector in the vector store,
      // so vector search quality is not degraded
    }
  }

  async close(): Promise<void> {
    await this.vectors.close();
    this.db.close();
    this.loaded = false;
  }

  /** Direct database access for advanced use cases (e.g. migration). */
  getRawDb(): Database.Database {
    return this.db;
  }
}

/** Factory for the SQLite-backed memory provider. */
export function createSqliteMemoryProvider(opts: SqliteMemoryProviderOptions): IMemoryProvider {
  return new SqliteMemoryProvider(opts);
}
