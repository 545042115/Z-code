// @ziner/runtime — memory provider factory
//
// Creates the appropriate memory provider backend based on configuration.
// Supports both JSONL and SQLite backends, with optional auto-migration.

import { existsSync, statSync } from 'fs';
import { join } from 'path';
import type { IMemoryProvider } from '@ziner/contracts';
import { createJsonlMemoryProvider, type JsonlMemoryProviderOptions } from './provider';
import { createSqliteMemoryProvider, type SqliteMemoryProviderOptions } from './sqlite-provider';
import { migrateJsonlToSqlite, type MigrationOptions } from './migrate';

export type StorageBackend = 'jsonl' | 'sqlite';

export interface MemoryProviderFactoryOptions {
  /** Storage backend to use. Default 'jsonl' for backward compatibility. */
  backend?: StorageBackend;
  /** Root directory for memory data. */
  rootDir: string;
  /**
   * When switching to SQLite and JSONL data exists, automatically migrate.
   * Default: true.
   */
  autoMigrate?: boolean;
  /**
   * Called during auto-migration with progress updates.
   */
  onMigrationProgress?: (processed: number, total: number) => void;
  /**
   * JSONL-specific options (passed through when backend === 'jsonl').
   */
  jsonlOptions?: Partial<JsonlMemoryProviderOptions>;
  /**
   * SQLite-specific options (passed through when backend === 'sqlite').
   */
  sqliteOptions?: Partial<SqliteMemoryProviderOptions>;
}

export interface CreateMemoryProviderResult {
  provider: IMemoryProvider;
  backend: StorageBackend;
  /** If migration was performed, contains the result. */
  migrationResult?: Awaited<ReturnType<typeof migrateJsonlToSqlite>>;
}

/**
 * Create a memory provider based on configuration.
 *
 * Automatically handles:
 * - Backend selection (jsonl / sqlite)
 * - Auto-migration from JSONL to SQLite when enabled
 * - Graceful fallback if SQLite is not available
 */
export async function createMemoryProvider(
  opts: MemoryProviderFactoryOptions,
): Promise<CreateMemoryProviderResult> {
  const backend = opts.backend ?? 'jsonl';
  const autoMigrate = opts.autoMigrate !== false;

  if (backend === 'sqlite') {
    try {
      const provider = createSqliteMemoryProvider({
        rootDir: opts.rootDir,
        ...opts.sqliteOptions,
      });

      // Initialize schema
      if ('initialize' in provider && typeof (provider as any).initialize === 'function') {
        await (provider as any).initialize();
      }

      let migrationResult: Awaited<ReturnType<typeof migrateJsonlToSqlite>> | undefined;

      // Auto-migrate from JSONL if enabled and JSONL file exists
      if (autoMigrate) {
        const jsonlPath = join(opts.rootDir, opts.jsonlOptions?.memoriesFile ?? 'memories.jsonl');
        if (existsSync(jsonlPath)) {
          const stats = statSync(jsonlPath);
          // Only migrate if JSONL has actual content
          if (stats.size > 0) {
            migrationResult = await migrateJsonlToSqlite({
              jsonlPath,
              sqliteDir: opts.rootDir,
              dbFile: opts.sqliteOptions?.dbFile,
              onProgress: opts.onMigrationProgress,
            });
          }
        }
      }

      return {
        provider,
        backend: 'sqlite',
        migrationResult,
      };
    } catch (err) {
      // Fallback to JSONL if SQLite fails
      console.warn('[memory] SQLite backend failed, falling back to JSONL:', err);
      const provider = createJsonlMemoryProvider({
        rootDir: opts.rootDir,
        ...opts.jsonlOptions,
      });
      return {
        provider,
        backend: 'jsonl',
      };
    }
  }

  // Default: JSONL
  const provider = createJsonlMemoryProvider({
    rootDir: opts.rootDir,
    ...opts.jsonlOptions,
  });
  return {
    provider,
    backend: 'jsonl',
  };
}
