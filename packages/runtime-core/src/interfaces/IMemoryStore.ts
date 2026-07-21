// IMemoryStore — memory storage abstraction.
// Desktop: backed by SQLite (better-sqlite3) or JSONL.
// Mobile: backed by IndexedDB.

import type { MemoryRecord, MemoryListFilter, MemoryPurgeFilter, MemoryHit, MemoryQuery } from '@ziner/contracts';

export interface IMemoryStore {
  /** Store a memory record. Returns the stored record (with id if new). */
  save(record: MemoryRecord): Promise<MemoryRecord>;
  /** Get a single memory by id. */
  get(id: string): Promise<MemoryRecord | undefined>;
  /** List memories (newest first), optionally filtered. */
  list(filter?: MemoryListFilter): Promise<MemoryRecord[]>;
  /** Search/recall memories matching the query. */
  search(query: string, limit?: number): Promise<MemoryHit[]>;
  /** Soft-delete a memory by id. */
  delete(id: string): Promise<boolean>;
  /** Hard-delete all memories. */
  clear(): Promise<number>;
  /** Count memories matching the filter. */
  count(filter?: MemoryListFilter): Promise<number>;
  /** Close the store and release handles. */
  close(): Promise<void>;
}
