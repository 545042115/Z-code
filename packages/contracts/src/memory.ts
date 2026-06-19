// Memory Contracts — cross-session Long-Term Memory types for V2.
//
// `IMemoryProvider` is the smallest surface the Runtime needs to store,
// recall, and forget memories. Concrete backends (JSONL, SQLite, vector
// stores) implement this; agents consume it through the higher-level
// memory managers in `@z-assistant/runtime/memory`.

// ── Memory Scope ───────────────────────────────────────────────────────

/** Who can see a memory. */
export type MemoryScope =
  | 'session'   // only the current session
  | 'user'      // any session for the same user
  | 'agent'     // any run using the same agent
  | 'project'   // any run in the same project/workspace
  | 'global';   // shared across all agents / users (use sparingly)

// ── Memory Kind ────────────────────────────────────────────────────────

/** Semantic category of a memory. */
export type MemoryKind =
  | 'short-term'   // current conversation turns
  | 'long-term'    // durable facts and learnings
  | 'episodic'     // task-level "I did X on project Y"
  | 'semantic'     // concept-level "I know X"
  | 'procedural'   // skill-level "I can do X"
  | 'preference';  // user preferences and style

// ── Memory Record ──────────────────────────────────────────────────────

/** A single memory item. */
export interface MemoryRecord {
  /** Stable unique id (ULID / UUID). */
  id: string;
  /** Human-readable / searchable content. */
  content: string;
  /** Memory category. */
  kind: MemoryKind;
  /** Visibility scope. */
  scope: MemoryScope;
  /** Owning user id (empty for anonymous). */
  userId: string;
  /** Session id for session-scoped memories. */
  sessionId?: string;
  /** Agent name for agent-scoped memories. */
  agentName?: string;
  /** Project / workspace id for project-scoped memories. */
  projectId?: string;
  /** Parent Run id for provenance. */
  runId?: string;
  /** Optional structured payload (e.g. extracted preference key/value). */
  payload?: Record<string, unknown>;
  /** Optional embedding vector for semantic recall. */
  vector?: number[];
  /** Importance score in [0, 1]; used by retention policy. */
  importance?: number;
  /** Creation timestamp (epoch ms). */
  createdAt: number;
  /** Last access timestamp (epoch ms); updated on recall. */
  accessedAt?: number;
  /** Soft-deleted flag; true if pending purge. */
  deleted?: boolean;
}

// ── Memory Query ───────────────────────────────────────────────────────

export interface MemoryQuery {
  /** Free-text search. */
  query: string;
  /** Filter by kind(s). */
  kind?: MemoryKind | MemoryKind[];
  /** Filter by scope(s). */
  scope?: MemoryScope | MemoryScope[];
  /** Filter by user id. */
  userId?: string;
  /** Filter by session id. */
  sessionId?: string;
  /** Filter by agent name. */
  agentName?: string;
  /** Filter by project id. */
  projectId?: string;
  /** Filter by run id. */
  runId?: string;
  /** Max records to return; default 10. */
  limit?: number;
  /** Minimum similarity score for vector recall; default 0.7. */
  minScore?: number;
}

/** A single recalled memory plus its relevance score. */
export interface MemoryHit {
  memory: MemoryRecord;
  /** Hybrid score in [0, 1]; 1 = best match. */
  score: number;
  /** Which signals produced the score. */
  reasons: MemoryHitReason[];
}

export interface MemoryHitReason {
  type: 'vector' | 'keyword' | 'kind' | 'scope' | 'time';
  score: number;
  detail?: string;
}

// ── Memory Write Policy ────────────────────────────────────────────────

/** Controls what gets written and when. */
export interface MemoryWritePolicy {
  /** Kinds allowed to be persisted by this writer. */
  allowedKinds?: MemoryKind[];
  /** Max memory records per (scope, kind) window; 0 = unlimited. */
  maxPerWindow?: number;
  /** Window size in ms for maxPerWindow; default 24h. */
  windowMs?: number;
  /** Require importance >= threshold before long-term retention. */
  minImportance?: number;
  /** True to mark old duplicates as deleted instead of keeping both. */
  deduplicate?: boolean;
}

// ── IMemoryProvider ────────────────────────────────────────────────────

/**
 * Low-level memory backend contract. Implementations are responsible for
 * persistence, indexing, vector search, and privacy-aware deletion.
 */
export interface IMemoryProvider {
  readonly name: string;

  /** Store a memory record. Returns the stored record (with id if new). */
  store(record: MemoryRecord): Promise<MemoryRecord>;

  /** Recall memories matching the query, ranked by relevance. */
  recall(q: MemoryQuery): Promise<MemoryHit[]>;

  /** List memories (newest first), optionally filtered. */
  list(filter?: MemoryListFilter): Promise<MemoryRecord[]>;

  /** Get a single memory by id. */
  get(id: string): Promise<MemoryRecord | undefined>;

  /** Soft-delete a memory by id. */
  delete(id: string): Promise<boolean>;

  /** Hard-delete all memories matching the filter (GDPR / user request). */
  purge(filter: MemoryPurgeFilter): Promise<number>;

  /** Count memories matching the filter. */
  count(filter?: MemoryListFilter): Promise<number>;

  /** Close the provider and release handles. */
  close(): Promise<void>;
}

export interface MemoryListFilter {
  kind?: MemoryKind | MemoryKind[];
  scope?: MemoryScope | MemoryScope[];
  userId?: string;
  sessionId?: string;
  agentName?: string;
  projectId?: string;
  runId?: string;
  includeDeleted?: boolean;
  limit?: number;
  offset?: number;
}

export interface MemoryPurgeFilter {
  /** Purge only this user's data. Required for safety. */
  userId: string;
  kind?: MemoryKind | MemoryKind[];
  scope?: MemoryScope | MemoryScope[];
  sessionId?: string;
  agentName?: string;
  projectId?: string;
  before?: number;
}

// ── IEmbeddingProvider ─────────────────────────────────────────────────

/**
 * Pluggable embedding provider. The default runtime ships with a tiny
 * local fallback; production deployments swap in OpenAI / Cohere / local
 * sentence-transformers backends.
 */
export interface IEmbeddingProvider {
  readonly name: string;
  readonly dimensions: number;

  /** Embed a single piece of text into a dense vector. */
  embed(text: string): Promise<number[]>;

  /** Embed many texts in one call when the backend supports batching. */
  embedBatch?(texts: string[]): Promise<number[][]>;

  /** Cheap health check. */
  health?(): Promise<{ ok: boolean; reason?: string; checkedAt: number }>;
}
