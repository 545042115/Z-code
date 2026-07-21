// IStorage — key-value storage abstraction.
// Desktop: backed by fs (JSON files).
// Mobile: backed by IndexedDB.

export interface IStorage {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<boolean>;
  list(prefix?: string): Promise<string[]>;
}
