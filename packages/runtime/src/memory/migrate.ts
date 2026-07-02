// @ziner/runtime — Memory migration tool: JSONL → SQLite
//
// Migrates existing JSONL memory files to SQLite format.
// Safe to run multiple times (idempotent).
//
// Usage:
//   import { migrateJsonlToSqlite } from '@ziner/runtime/memory';
//   const result = await migrateJsonlToSqlite({
//     jsonlPath: '/path/to/memories.jsonl',
//     sqliteDir: '/path/to/sqlite-dir',
//   });

import { promises as fsp, existsSync } from 'fs';
import type { MemoryRecord } from '@ziner/contracts';
import { createJsonlMemoryProvider } from './provider';
import { SqliteMemoryProvider } from './sqlite-provider';

export interface MigrationOptions {
  /** Path to the source JSONL file. */
  jsonlPath: string;
  /** Directory for the SQLite database (will be created if missing). */
  sqliteDir: string;
  /** SQLite filename inside sqliteDir. Default 'memories.db'. */
  dbFile?: string;
  /**
   * If true, skip memories that already exist (by id).
   * If false, overwrite existing memories with the same id.
   * Default: true (safe for re-runs).
   */
  skipExisting?: boolean;
  /** Progress callback, called for every batch. */
  onProgress?: (processed: number, total: number) => void;
}

export interface MigrationResult {
  total: number;
  migrated: number;
  skipped: number;
  failed: number;
  errors: Array<{ id?: string; error: string }>;
}

async function readJsonl(file: string): Promise<MemoryRecord[]> {
  if (!existsSync(file)) return [];
  const text = await fsp.readFile(file, 'utf8');
  if (!text) return [];
  const out: MemoryRecord[] = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      const rec = JSON.parse(line);
      // Skip tombstone entries
      if (rec.__deleted) continue;
      if (!rec.id) continue;
      out.push(rec);
    } catch {
      // skip malformed
    }
  }
  return out;
}

/**
 * Migrate memories from JSONL to SQLite.
 *
 * The source JSONL file is NOT modified. Read-only on the source.
 * Idempotent: re-running won't create duplicates (by id).
 */
export async function migrateJsonlToSqlite(
  opts: MigrationOptions,
): Promise<MigrationResult> {
  const result: MigrationResult = {
    total: 0,
    migrated: 0,
    skipped: 0,
    failed: 0,
    errors: [],
  };

  const skipExisting = opts.skipExisting !== false;

  // Read all records from JSONL
  const records = await readJsonl(opts.jsonlPath);
  result.total = records.length;

  if (result.total === 0) {
    return result;
  }

  // Create SQLite provider
  const sqlite = new SqliteMemoryProvider({
    rootDir: opts.sqliteDir,
    dbFile: opts.dbFile ?? 'memories.db',
  });

  try {
    // Ensure schema is initialized before preparing statements
    await sqlite.initialize();

    const db = sqlite.getRawDb();
    const selectStmt = db.prepare('SELECT id FROM memories WHERE id = ?');

    for (let i = 0; i < records.length; i++) {
      const rec = records[i];
      try {
        // Check if already exists
        const existing = selectStmt.get(rec.id);
        if (existing && skipExisting) {
          result.skipped++;
          continue;
        }

        // Insert via provider (handles vector indexing, dedup, etc.)
        await sqlite.store(rec);
        result.migrated++;
      } catch (err: unknown) {
        result.failed++;
        result.errors.push({
          id: rec.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // Progress update every 100 records
      if (opts.onProgress && (i + 1) % 100 === 0) {
        opts.onProgress(i + 1, result.total);
      }
    }

    // Final progress update
    if (opts.onProgress) {
      opts.onProgress(result.total, result.total);
    }
  } finally {
    await sqlite.close();
  }

  return result;
}
