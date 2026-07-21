// IndexedDBMemoryStore — MemoryManager for Web/Mobile Runtime
//
// Lightweight memory system using IndexedDB. Provides the same core
// features as the desktop MemoryManager: short-term, long-term, facts,
// and a similarity search.

import { getStorage, type StorageBackend } from './IndexedDBStorage';

export type MemoryKind = 'short-term' | 'long-term' | 'fact' | 'preference';
export type MemoryScope = 'user' | 'project' | 'session';

export interface MemoryRecord {
  id: string;
  content: string;
  kind: MemoryKind;
  scope: MemoryScope;
  userId?: string;
  sessionId?: string;
  createdAt: number;
  updatedAt?: number;
  /** Optional metadata (importance, source, tags). */
  metadata?: Record<string, unknown>;
  /** Optional embedding vector for semantic search. */
  embedding?: number[];
}

export interface MemoryFilter {
  kind?: MemoryKind;
  scope?: MemoryScope;
  userId?: string;
  sessionId?: string;
  limit?: number;
  offset?: number;
}

export interface MemoryQuery {
  query: string;
  limit?: number;
  threshold?: number;
}

export interface MemorySearchResult {
  memory: MemoryRecord;
  score: number;
}

export interface MemoryManagerOptions {
  userId?: string;
}

export class MemoryManager {
  private storage: StorageBackend;
  private userId: string;
  private initialized = false;

  constructor(options: MemoryManagerOptions = {}) {
    this.storage = getStorage();
    this.userId = options.userId ?? 'default';
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    await this.storage.open();
    this.initialized = true;
  }

  private ensureInit(): void {
    if (!this.initialized) {
      throw new Error('MemoryManager not initialized. Call init() first.');
    }
  }

  /** Store a new memory. */
  async remember(
    content: string,
    kind: MemoryKind = 'long-term',
    scope: MemoryScope = 'user',
    options: { id?: string; userId?: string; sessionId?: string; metadata?: Record<string, unknown> } = {},
  ): Promise<MemoryRecord> {
    this.ensureInit();
    const id = options.id ?? `mem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const record: MemoryRecord = {
      id,
      content,
      kind,
      scope,
      userId: options.userId ?? this.userId,
      sessionId: options.sessionId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      metadata: options.metadata,
    };
    await this.storage.put('memories', record);
    return record;
  }

  /** List memories with optional filtering. */
  async list(filter: MemoryFilter = {}): Promise<MemoryRecord[]> {
    this.ensureInit();
    let memories = await this.storage.list<MemoryRecord>('memories');

    if (filter.kind) memories = memories.filter((m) => m.kind === filter.kind);
    if (filter.scope) memories = memories.filter((m) => m.scope === filter.scope);
    if (filter.userId) memories = memories.filter((m) => m.userId === filter.userId);
    if (filter.sessionId) memories = memories.filter((m) => m.sessionId === filter.sessionId);

    memories.sort((a, b) => b.createdAt - a.createdAt);

    if (filter.offset) memories = memories.slice(filter.offset);
    if (filter.limit) memories = memories.slice(0, filter.limit);

    return memories;
  }

  /** Get a specific memory by id. */
  async get(id: string): Promise<MemoryRecord | undefined> {
    this.ensureInit();
    return this.storage.get<MemoryRecord>('memories', id);
  }

  /** Delete a memory by id. */
  async forget(id: string): Promise<boolean> {
    this.ensureInit();
    try {
      await this.storage.delete('memories', id);
      return true;
    } catch {
      return false;
    }
  }

  /** Search memories using a simple similarity algorithm. */
  async recall(query: MemoryQuery): Promise<MemorySearchResult[]> {
    this.ensureInit();
    const all = await this.storage.list<MemoryRecord>('memories');
    const queryTerms = tokenize(query.query);

    const scored = all.map((memory) => {
      const memTerms = tokenize(memory.content);
      const score = jaccardSimilarity(queryTerms, memTerms);
      return { memory, score };
    });

    const filtered = scored
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score);

    return filtered.slice(0, query.limit ?? 10);
  }

  /** Store a fact (extracted structured knowledge). */
  async rememberFact(
    factType: string,
    entity: string,
    value: string,
    confidence = 1.0,
  ): Promise<MemoryRecord> {
    const id = `fact-${factType}-${entity}-${hashString(value)}`;
    const existing = await this.storage.get<MemoryRecord>('memories', id);
    if (existing) {
      existing.updatedAt = Date.now();
      existing.metadata = { ...(existing.metadata ?? {}), confidence };
      await this.storage.put('memories', existing);
      return existing;
    }
    return this.remember(`${factType}:${entity}=${value}`, 'fact', 'user', {
      id,
      metadata: { factType, entity, value, confidence },
    });
  }

  /** Get all stored facts. */
  async listFacts(): Promise<MemoryRecord[]> {
    return this.list({ kind: 'fact' });
  }

  /** Count total memories. */
  async count(): Promise<number> {
    this.ensureInit();
    return this.storage.count('memories');
  }

  /** Clear all memories (use with caution). */
  async clear(): Promise<void> {
    this.ensureInit();
    await this.storage.clear('memories');
  }
}

// ── Helper functions ──────────────────────────────────────────────

function tokenize(text: string): Set<string> {
  // Simple tokenization: lowercase + Chinese character segmentation
  const result = new Set<string>();
  const lower = text.toLowerCase().trim();

  // English words
  const englishWords = lower.match(/[a-z0-9]+/g) || [];
  englishWords.forEach((w) => w.length > 1 && result.add(w));

  // Chinese characters (bigrams)
  const chineseChars = lower.match(/[\u4e00-\u9fa5]/g) || [];
  for (let i = 0; i < chineseChars.length - 1; i++) {
    result.add(chineseChars[i] + chineseChars[i + 1]);
  }
  if (chineseChars.length > 0) {
    result.add(chineseChars.join(''));
  }

  return result;
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) intersection++;
  }
  return intersection / (a.size + b.size - intersection);
}

function hashString(s: string): string {
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) - hash) + s.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}
