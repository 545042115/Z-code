import type { IMemoryStore } from '@ziner/runtime-core';
import type { MemoryHit, MemoryListFilter, MemoryRecord } from '@ziner/contracts';
import { createMemoryProvider, type IMemoryProvider, type StorageBackend } from '@ziner/runtime/memory';

export interface NodeMemoryStoreOptions {
  rootDir: string;
  backend?: StorageBackend;
  userId?: string;
  autoMigrate?: boolean;
  onMigrationProgress?: (processed: number, total: number) => void;
}

export class NodeMemoryStore implements IMemoryStore {
  private providerPromise: Promise<IMemoryProvider>;
  private userId: string;

  constructor(options: NodeMemoryStoreOptions) {
    this.userId = options.userId ?? 'desktop-user';
    this.providerPromise = createMemoryProvider({
      rootDir: options.rootDir,
      backend: options.backend,
      autoMigrate: options.autoMigrate,
      onMigrationProgress: options.onMigrationProgress,
    }).then((result) => result.provider);
  }

  private async provider(): Promise<IMemoryProvider> {
    return this.providerPromise;
  }

  async save(record: MemoryRecord): Promise<MemoryRecord> {
    return (await this.provider()).store(record);
  }

  async get(id: string): Promise<MemoryRecord | undefined> {
    return (await this.provider()).get(id);
  }

  async list(filter?: MemoryListFilter): Promise<MemoryRecord[]> {
    return (await this.provider()).list(filter);
  }

  async search(query: string, limit?: number): Promise<MemoryHit[]> {
    return (await this.provider()).recall({ query, limit, userId: this.userId });
  }

  async delete(id: string): Promise<boolean> {
    return (await this.provider()).delete(id);
  }

  async clear(): Promise<number> {
    return (await this.provider()).purge({ userId: this.userId });
  }

  async count(filter?: MemoryListFilter): Promise<number> {
    return (await this.provider()).count(filter);
  }

  async close(): Promise<void> {
    await (await this.provider()).close();
  }
}
