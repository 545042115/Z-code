// IndexedDB Storage Layer for Web/Mobile Runtime
//
// Lightweight wrapper around IndexedDB for mobile/web runtime storage.
// Replaces SQLite/JSONL — works in any browser/WebView.

const DB_NAME = 'zcode-mobile-runtime';
const DB_VERSION = 1;

export type StoreName = 'memories' | 'sessions' | 'conversations' | 'traces' | 'facts' | 'checkpoints' | 'mcp_state' | 'preferences';

export interface StorageBackend {
  open(): Promise<void>;
  close(): Promise<void>;
  put<T>(store: StoreName, value: T & { id: string }): Promise<void>;
  get<T>(store: StoreName, id: string): Promise<T | undefined>;
  delete(store: StoreName, id: string): Promise<void>;
  list<T>(store: StoreName, filter?: { index?: string; range?: IDBKeyRange; limit?: number; offset?: number }): Promise<T[]>;
  count(store: StoreName, filter?: { index?: string; range?: IDBKeyRange }): Promise<number>;
  clear(store: StoreName): Promise<void>;
}

class IndexedDBStorage implements StorageBackend {
  private db: IDBDatabase | null = null;
  private openingPromise: Promise<void> | null = null;

  async open(): Promise<void> {
    if (this.db) return;
    if (this.openingPromise) return this.openingPromise;

    this.openingPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);

      req.onupgradeneeded = (e) => {
        const db = (e.target as IDBOpenDBRequest).result;

        // Memories store with indexes
        if (!db.objectStoreNames.contains('memories')) {
          const memStore = db.createObjectStore('memories', { keyPath: 'id' });
          memStore.createIndex('scope', 'scope', { unique: false });
          memStore.createIndex('kind', 'kind', { unique: false });
          memStore.createIndex('userId', 'userId', { unique: false });
          memStore.createIndex('createdAt', 'createdAt', { unique: false });
        }

        // Sessions store
        if (!db.objectStoreNames.contains('sessions')) {
          const sessStore = db.createObjectStore('sessions', { keyPath: 'id' });
          sessStore.createIndex('updatedAt', 'updatedAt', { unique: false });
        }

        // Conversations store
        if (!db.objectStoreNames.contains('conversations')) {
          const convStore = db.createObjectStore('conversations', { keyPath: 'id' });
          convStore.createIndex('updatedAt', 'updatedAt', { unique: false });
        }

        // Traces store
        if (!db.objectStoreNames.contains('traces')) {
          const traceStore = db.createObjectStore('traces', { keyPath: 'id' });
          traceStore.createIndex('sessionId', 'sessionId', { unique: false });
          traceStore.createIndex('createdAt', 'createdAt', { unique: false });
        }

        // Facts store (extracted from conversations)
        if (!db.objectStoreNames.contains('facts')) {
          const factStore = db.createObjectStore('facts', { keyPath: 'id' });
          factStore.createIndex('type', 'type', { unique: false });
        }

        // Checkpoints store
        if (!db.objectStoreNames.contains('checkpoints')) {
          const cpStore = db.createObjectStore('checkpoints', { keyPath: 'id' });
          cpStore.createIndex('sessionId', 'sessionId', { unique: false });
        }

        // MCP state
        if (!db.objectStoreNames.contains('mcp_state')) {
          db.createObjectStore('mcp_state', { keyPath: 'id' });
        }

        // Preferences (key-value)
        if (!db.objectStoreNames.contains('preferences')) {
          db.createObjectStore('preferences', { keyPath: 'key' });
        }
      };

      req.onsuccess = () => {
        this.db = req.result;
        this.db.onversionchange = () => {
          this.db?.close();
          this.db = null;
        };
        resolve();
      };

      req.onerror = () => reject(new Error('Failed to open IndexedDB'));
    });

    return this.openingPromise;
  }

  async close(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  private ensureDB(): IDBDatabase {
    if (!this.db) throw new Error('IndexedDB not opened. Call open() first.');
    return this.db;
  }

  async put<T>(store: StoreName, value: T & { id: string }): Promise<void> {
    await this.open();
    return new Promise((resolve, reject) => {
      const tx = this.ensureDB().transaction(store, 'readwrite');
      const os = tx.objectStore(store);
      const req = os.put(value);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(new Error(`Failed to put into ${store}`));
    });
  }

  async get<T>(store: StoreName, id: string): Promise<T | undefined> {
    await this.open();
    return new Promise((resolve, reject) => {
      const tx = this.ensureDB().transaction(store, 'readonly');
      const os = tx.objectStore(store);
      const req = os.get(id);
      req.onsuccess = () => resolve(req.result as T | undefined);
      req.onerror = () => reject(new Error(`Failed to get from ${store}`));
    });
  }

  async delete(store: StoreName, id: string): Promise<void> {
    await this.open();
    return new Promise((resolve, reject) => {
      const tx = this.ensureDB().transaction(store, 'readwrite');
      const os = tx.objectStore(store);
      const req = os.delete(id);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(new Error(`Failed to delete from ${store}`));
    });
  }

  async list<T>(
    store: StoreName,
    filter?: { index?: string; range?: IDBKeyRange; limit?: number; offset?: number },
  ): Promise<T[]> {
    await this.open();
    return new Promise((resolve, reject) => {
      const tx = this.ensureDB().transaction(store, 'readonly');
      const os = tx.objectStore(store);
      const source: IDBIndex | IDBObjectStore = filter?.index ? os.index(filter.index) : os;
      const req = source.getAll(filter?.range);
      req.onsuccess = () => {
        let results = req.result as T[];
        if (filter?.offset) results = results.slice(filter.offset);
        if (filter?.limit) results = results.slice(0, filter.limit);
        resolve(results);
      };
      req.onerror = () => reject(new Error(`Failed to list ${store}`));
    });
  }

  async count(store: StoreName, filter?: { index?: string; range?: IDBKeyRange }): Promise<number> {
    await this.open();
    return new Promise((resolve, reject) => {
      const tx = this.ensureDB().transaction(store, 'readonly');
      const os = tx.objectStore(store);
      const source: IDBIndex | IDBObjectStore = filter?.index ? os.index(filter.index) : os;
      const req = source.count(filter?.range);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(new Error(`Failed to count ${store}`));
    });
  }

  async clear(store: StoreName): Promise<void> {
    await this.open();
    return new Promise((resolve, reject) => {
      const tx = this.ensureDB().transaction(store, 'readwrite');
      const os = tx.objectStore(store);
      const req = os.clear();
      req.onsuccess = () => resolve();
      req.onerror = () => reject(new Error(`Failed to clear ${store}`));
    });
  }
}

// Singleton instance
let instance: IndexedDBStorage | null = null;

export function getStorage(): IndexedDBStorage {
  if (!instance) {
    instance = new IndexedDBStorage();
  }
  return instance;
}

export async function openStorage(): Promise<StorageBackend> {
  const s = getStorage();
  await s.open();
  return s;
}
