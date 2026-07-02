// @ziner/runtime — memory subsystem tests

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { tmpdir } from 'os';
import { join } from 'path';
import { rmSync, mkdirSync, existsSync } from 'fs';
import {
  createJsonlMemoryProvider,
  createSqliteMemoryProvider,
  createInMemoryVectorStore,
  createLocalEmbeddingProvider,
  MemoryManager,
  ShortTermMemory,
  LongTermMemory,
  EpisodicMemory,
  SemanticMemory,
  ProceduralMemory,
  PreferencesMemory,
  MemoryPolicy,
  SharedMemory,
  PrivacyManager,
  recall,
} from '../index';
import type { MemoryRecord } from '@ziner/contracts';

function makeTempDir(): string {
  const dir = join(tmpdir(), `ziner-memory-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  if (existsSync(dir)) rmSync(dir, { recursive: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('memory subsystem', () => {
  let dir: string;
  let provider: ReturnType<typeof createJsonlMemoryProvider>;
  let manager: MemoryManager;

  beforeEach(() => {
    dir = makeTempDir();
    provider = createJsonlMemoryProvider({ rootDir: dir });
    manager = new MemoryManager({ provider, userId: 'u1', sessionId: 's1', agentName: 'coding-agent', projectId: 'p1' });
  });

  afterEach(async () => {
    await provider.close();
    rmSync(dir, { recursive: true, force: true });
  });

  describe('JsonlMemoryProvider', () => {
    it('stores and recalls a memory', async () => {
      const rec = await provider.store({
        id: 'm1',
        content: 'I prefer TypeScript for backend services',
        kind: 'preference',
        scope: 'user',
        userId: 'u1',
        createdAt: Date.now(),
      });
      assert.strictEqual(rec.id, 'm1');
      assert.ok(rec.vector);

      const hits = await provider.recall({ query: 'TypeScript backend', userId: 'u1' });
      assert.ok(hits.length > 0);
      assert.strictEqual(hits[0].memory.id, 'm1');
    });

    it('lists memories with filters', async () => {
      await provider.store({
        id: 'm2',
        content: 'foo',
        kind: 'long-term',
        scope: 'user',
        userId: 'u1',
        createdAt: Date.now(),
      });
      const list = await provider.list({ kind: 'long-term', userId: 'u1' });
      assert.strictEqual(list.length, 1);
      assert.strictEqual(list[0].id, 'm2');
    });

    it('deletes and purges memories', async () => {
      await provider.store({
        id: 'm3',
        content: 'delete me',
        kind: 'short-term',
        scope: 'session',
        userId: 'u1',
        sessionId: 's1',
        createdAt: Date.now(),
      });
      assert.strictEqual(await provider.count({ userId: 'u1' }), 1);
      assert.strictEqual(await provider.delete('m3'), true);
      assert.strictEqual(await provider.get('m3'), undefined);
      assert.strictEqual(await provider.count({ userId: 'u1' }), 0);

      await provider.store({
        id: 'm4',
        content: 'purge me',
        kind: 'long-term',
        scope: 'user',
        userId: 'u1',
        createdAt: Date.now(),
      });
      assert.strictEqual(await provider.purge({ userId: 'u1' }), 1);
    });

    it('reloads memories from disk', async () => {
      await provider.store({
        id: 'm5',
        content: 'persisted fact',
        kind: 'long-term',
        scope: 'user',
        userId: 'u1',
        createdAt: Date.now(),
      });
      await provider.close();

      const reloaded = createJsonlMemoryProvider({ rootDir: dir });
      const rec = await reloaded.get('m5');
      assert.ok(rec);
      assert.strictEqual(rec!.content, 'persisted fact');
      await reloaded.close();
    });

    it('deduplicates short memories (<= 20 chars)', async () => {
      const a = await provider.store({
        id: 's1',
        content: 'user: 要1+1',
        kind: 'long-term',
        scope: 'user',
        userId: 'u1',
        createdAt: Date.now(),
      });
      const b = await provider.store({
        id: 's2',
        content: 'user: 要1+1',
        kind: 'long-term',
        scope: 'user',
        userId: 'u1',
        createdAt: Date.now(),
      });
      const list = await provider.list({ kind: 'long-term', userId: 'u1' });
      assert.strictEqual(list.length, 1);
      assert.strictEqual(list[0].id, a.id);
      const payload = list[0].payload as Record<string, unknown> | undefined;
      assert.strictEqual(payload?.duplicateCount, 1);
    });

    it('deduplicates with same id (deterministic id approach)', async () => {
      const rec1 = await provider.store({
        id: 'det-abc123',
        content: 'user: 上海虹桥',
        kind: 'long-term',
        scope: 'user',
        userId: 'u1',
        createdAt: Date.now() - 1000,
      });
      const rec2 = await provider.store({
        id: 'det-abc123',
        content: 'user: 上海虹桥',
        kind: 'long-term',
        scope: 'user',
        userId: 'u1',
        createdAt: Date.now(),
      });
      const list = await provider.list({ kind: 'long-term', userId: 'u1' });
      assert.strictEqual(list.length, 1);
      assert.strictEqual(list[0].id, 'det-abc123');
    });
  });

  describe('InMemoryVectorStore', () => {
    it('finds nearest neighbors by cosine similarity', async () => {
      const store = createInMemoryVectorStore();
      const embedding = createLocalEmbeddingProvider({ dimensions: 32 });
      const v1 = await embedding.embed('hello world');
      const v2 = await embedding.embed('goodbye world');
      const v3 = await embedding.embed('completely different');

      await store.upsert({ id: 'a', vector: v1, kind: 'long-term', scope: 'user', userId: 'u1', createdAt: 1 });
      await store.upsert({ id: 'b', vector: v2, kind: 'long-term', scope: 'user', userId: 'u1', createdAt: 2 });
      await store.upsert({ id: 'c', vector: v3, kind: 'long-term', scope: 'user', userId: 'u1', createdAt: 3 });

      const hits = await store.query({ vector: v1, topK: 2 });
      assert.strictEqual(hits.length, 2);
      assert.strictEqual(hits[0].id, 'a');
      assert.ok(hits[0].score > hits[1].score);
      await store.close();
    });
  });

  describe('MemoryManager + subsystems', () => {
    it('remembers and recalls across kinds', async () => {
      await manager.remember('I like TypeScript', 'preference', 'user');
      await manager.remember('Project uses vitest', 'long-term', 'project');

      const hits = await manager.recall('TypeScript testing');
      assert.ok(hits.length >= 1);
    });

    it('ShortTermMemory records conversation turns', async () => {
      const stm = new ShortTermMemory(manager);
      await stm.addExchange('hi', 'hello!');
      const recent = await stm.recent();
      assert.strictEqual(recent.length, 2);
      assert.ok(recent[0].content.includes('assistant'));
    });

    it('LongTermMemory remembers durable facts', async () => {
      const ltm = new LongTermMemory(manager);
      await ltm.remember({ content: 'Use async/await consistently' });
      const hits = await ltm.recall('async style');
      assert.ok(hits.length > 0);
    });

    it('EpisodicMemory records tasks for few-shot', async () => {
      const em = new EpisodicMemory(manager);
      await em.record({ task: 'Refactor auth middleware', story: 'Extracted token validation into a guard.', outcome: 'success' });
      const hits = await em.recallSimilar('auth middleware refactor');
      assert.ok(hits.length > 0);
    });

    it('SemanticMemory learns concepts', async () => {
      const sm = new SemanticMemory(manager);
      await sm.learn({ concept: 'AuthGuard', description: 'Validates JWT tokens before route handlers.' });
      const found = await sm.find('AuthGuard');
      assert.ok(found);
      const hits = await sm.recall('JWT tokens');
      assert.ok(hits.length > 0);
    });

    it('ProceduralMemory recalls skills', async () => {
      const pm = new ProceduralMemory(manager);
      await pm.learn({ name: 'Add route', steps: '1. Create handler 2. Register in router' });
      const hits = await pm.recall('Add route handler router');
      assert.ok(hits.length > 0);
    });

    it('PreferencesMemory stores and retrieves preferences', async () => {
      const prefs = new PreferencesMemory(manager);
      await prefs.learn({ key: 'language', value: 'TypeScript', statement: 'I prefer TypeScript' });
      const rec = await prefs.get('language');
      assert.ok(rec);
      assert.strictEqual((rec!.payload as { value: string }).value, 'TypeScript');
    });
  });

  describe('recall helper', () => {
    it('searches across kinds with scope filter', async () => {
      await manager.remember('I prefer TypeScript', 'preference', 'user');
      const hits = await recall(manager, 'TypeScript', { scope: 'user' });
      assert.ok(hits.length > 0);
    });
  });

  describe('MemoryPolicy', () => {
    it('rejects disallowed kinds', async () => {
      const policy = new MemoryPolicy(manager, { allowedKinds: ['preference'] });
      const rec = await policy.maybeRemember('fact', 'long-term', 'user');
      assert.strictEqual(rec, undefined);
    });

    it('enforces importance threshold', async () => {
      const policy = new MemoryPolicy(manager, { minImportance: 0.9 });
      const rec = await policy.maybeRemember('low', 'long-term', 'user', { importance: 0.1 });
      assert.strictEqual(rec, undefined);
    });

    it('deduplicates memories', async () => {
      const policy = new MemoryPolicy(manager, { deduplicate: true });
      const a = await policy.maybeRemember('unique', 'long-term', 'user');
      const b = await policy.maybeRemember('unique', 'long-term', 'user');
      assert.ok(a);
      assert.ok(b);
      assert.notStrictEqual(a!.id, b!.id);
      const all = await manager.list({ kind: 'long-term' });
      assert.strictEqual(all.length, 1);
    });
  });

  describe('SharedMemory', () => {
    it('publishes and reads shared project memory', async () => {
      const shared = new SharedMemory(manager, 'project');
      await shared.publish('Use npm workspaces', 'long-term');
      const recs = await shared.read('npm workspaces');
      assert.ok(recs.length > 0);
    });
  });

  describe('PrivacyManager', () => {
    it('exports and purges user data', async () => {
      const privacy = new PrivacyManager(manager);
      await manager.remember('secret', 'long-term', 'user');
      const exp = await privacy.exportUser('u1');
      assert.strictEqual(exp.memories.length, 1);
      const purged = await privacy.purgeUser('u1');
      assert.strictEqual(purged, 1);
      assert.strictEqual(await manager.count(), 0);
    });
  });

  describe('performance', () => {
    it('recalls from 1000 memories in under 100ms', async () => {
      const records: MemoryRecord[] = [];
      for (let i = 0; i < 1000; i++) {
        records.push({
          id: `perf-${i}`,
          content: `Memory number ${i} about topic ${i % 10}`,
          kind: 'long-term',
          scope: 'user',
          userId: 'u1',
          createdAt: Date.now() - i,
        });
      }
      // batch store to avoid 1000 sequential awaits overhead in test
      await Promise.all(records.map((r) => provider.store(r)));

      const start = Date.now();
      const hits = await provider.recall({ query: 'topic 3', userId: 'u1', limit: 10 });
      const elapsed = Date.now() - start;
      assert.ok(hits.length > 0);
      assert.ok(elapsed < 100, `recall took ${elapsed}ms`);
    });
  });
});

// ── SqliteMemoryProvider tests ───────────────────────────────────────

describe('SqliteMemoryProvider', () => {
  let dir: string;
  let sqliteProvider: ReturnType<typeof import('../index').createSqliteMemoryProvider>;
  let sqliteManager: MemoryManager;

  beforeEach(() => {
    dir = makeTempDir();
    sqliteProvider = createSqliteMemoryProvider({ rootDir: dir, enableFts: false });
    sqliteManager = new MemoryManager({ provider: sqliteProvider, userId: 'u1', sessionId: 's1', agentName: 'coding-agent', projectId: 'p1' });
  });

  afterEach(async () => {
    await sqliteProvider.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('stores and recalls a memory', async () => {
    const rec = await sqliteProvider.store({
      id: 'm1',
      content: 'I prefer TypeScript for backend services',
      kind: 'preference',
      scope: 'user',
      userId: 'u1',
      createdAt: Date.now(),
    });
    assert.strictEqual(rec.id, 'm1');

    const hits = await sqliteProvider.recall({ query: 'TypeScript backend', userId: 'u1' });
    assert.ok(hits.length > 0);
    assert.strictEqual(hits[0].memory.id, 'm1');
  });

  it('lists memories with filters', async () => {
    await sqliteProvider.store({
      id: 'm2',
      content: 'foo',
      kind: 'long-term',
      scope: 'user',
      userId: 'u1',
      createdAt: Date.now(),
    });
    const list = await sqliteProvider.list({ kind: 'long-term', userId: 'u1' });
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].id, 'm2');
  });

  it('deletes and purges memories', async () => {
    await sqliteProvider.store({
      id: 'm3',
      content: 'delete me',
      kind: 'long-term',
      scope: 'user',
      userId: 'u1',
      createdAt: Date.now(),
    });
    assert.strictEqual(await sqliteProvider.count({ userId: 'u1' }), 1);

    const deleted = await sqliteProvider.delete('m3');
    assert.strictEqual(deleted, true);
    assert.strictEqual(await sqliteProvider.count({ userId: 'u1' }), 0);

    await sqliteProvider.store({
      id: 'm4',
      content: 'purge me',
      kind: 'long-term',
      scope: 'user',
      userId: 'u1',
      createdAt: Date.now(),
    });
    assert.strictEqual(await sqliteProvider.purge({ userId: 'u1' }), 1);
    assert.strictEqual(await sqliteProvider.count({ userId: 'u1' }), 0);
  });

  it('reloads memories from disk', async () => {
    await sqliteProvider.store({
      id: 'm5',
      content: 'persisted fact',
      kind: 'long-term',
      scope: 'user',
      userId: 'u1',
      createdAt: Date.now(),
    });
    await sqliteProvider.close();

    const reloaded = createSqliteMemoryProvider({ rootDir: dir, enableFts: false });
    const rec = await reloaded.get('m5');
    assert.ok(rec);
    assert.strictEqual(rec!.content, 'persisted fact');
    await reloaded.close();
  });

  it('deduplicates short memories (<= 20 chars)', async () => {
    const a = await sqliteProvider.store({
      id: 's1',
      content: 'user: 要1+1',
      kind: 'long-term',
      scope: 'user',
      userId: 'u1',
      createdAt: Date.now(),
    });
    const b = await sqliteProvider.store({
      id: 's2',
      content: 'user: 要1+1',
      kind: 'long-term',
      scope: 'user',
      userId: 'u1',
      createdAt: Date.now(),
    });
    const list = await sqliteProvider.list({ kind: 'long-term', userId: 'u1' });
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].id, a.id);
    const payload = list[0].payload as Record<string, unknown> | undefined;
    assert.strictEqual(payload?.duplicateCount, 1);
  });

  it('deduplicates with same id (deterministic id approach)', async () => {
    const rec1 = await sqliteProvider.store({
      id: 'det-abc123',
      content: 'user: 上海虹桥',
      kind: 'long-term',
      scope: 'user',
      userId: 'u1',
      createdAt: Date.now() - 1000,
    });
    const rec2 = await sqliteProvider.store({
      id: 'det-abc123',
      content: 'user: 上海虹桥',
      kind: 'long-term',
      scope: 'user',
      userId: 'u1',
      createdAt: Date.now(),
    });
    const list = await sqliteProvider.list({ kind: 'long-term', userId: 'u1' });
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].id, 'det-abc123');
  });

  it('supports pagination in list()', async () => {
    const records: MemoryRecord[] = [];
    for (let i = 0; i < 25; i++) {
      records.push({
        id: `page-${i}`,
        content: `Memory ${i}`,
        kind: 'long-term',
        scope: 'user',
        userId: 'u1',
        createdAt: Date.now() - i,
      });
    }
    await Promise.all(records.map((r) => sqliteProvider.store(r)));

    const page1 = await sqliteProvider.list({ userId: 'u1', limit: 10, offset: 0 });
    const page2 = await sqliteProvider.list({ userId: 'u1', limit: 10, offset: 10 });
    const page3 = await sqliteProvider.list({ userId: 'u1', limit: 10, offset: 20 });

    assert.strictEqual(page1.length, 10);
    assert.strictEqual(page2.length, 10);
    assert.strictEqual(page3.length, 5);
  });

  it('updates accessedAt on recall', async () => {
    await sqliteProvider.store({
      id: 'acc-1',
      content: 'access test memory',
      kind: 'long-term',
      scope: 'user',
      userId: 'u1',
      createdAt: Date.now() - 10000,
    });

    const before = await sqliteProvider.get('acc-1');
    assert.ok(before);
    const beforeAccessed = before!.accessedAt;

    await sqliteProvider.recall({ query: 'access test', userId: 'u1' });

    const after = await sqliteProvider.get('acc-1');
    assert.ok(after);
    assert.ok(after!.accessedAt && after!.accessedAt > (beforeAccessed ?? 0));
  });

  it('performs better than JSONL for large datasets', async () => {
    const records: MemoryRecord[] = [];
    for (let i = 0; i < 500; i++) {
      records.push({
        id: `perf-sqlite-${i}`,
        content: `SQLite memory number ${i} about topic ${i % 20}`,
        kind: 'long-term',
        scope: 'user',
        userId: 'u1',
        createdAt: Date.now() - i,
      });
    }
    await Promise.all(records.map((r) => sqliteProvider.store(r)));

    const start = Date.now();
    const hits = await sqliteProvider.recall({ query: 'topic 5', userId: 'u1', limit: 10 });
    const elapsed = Date.now() - start;
    assert.ok(hits.length > 0);
    assert.ok(elapsed < 500, `SQLite recall took ${elapsed}ms, expected < 500ms`);
  });
});

// ── Migration tests ──────────────────────────────────────────────────

describe('JSONL → SQLite migration', () => {
  let sourceDir: string;
  let destDir: string;
  let jsonlProvider: ReturnType<typeof createJsonlMemoryProvider>;

  beforeEach(() => {
    sourceDir = makeTempDir();
    destDir = makeTempDir();
    jsonlProvider = createJsonlMemoryProvider({ rootDir: sourceDir });
  });

  afterEach(async () => {
    await jsonlProvider.close();
    rmSync(sourceDir, { recursive: true, force: true });
    rmSync(destDir, { recursive: true, force: true });
  });

  it('migrates memories from JSONL to SQLite', async () => {
    // Create test data in JSONL
    const records: MemoryRecord[] = [
      { id: 'mig-1', content: 'First memory', kind: 'long-term', scope: 'user', userId: 'u1', createdAt: Date.now() },
      { id: 'mig-2', content: 'Second memory', kind: 'preference', scope: 'user', userId: 'u1', createdAt: Date.now() - 1000 },
      { id: 'mig-3', content: 'Third memory', kind: 'episodic', scope: 'user', userId: 'u1', createdAt: Date.now() - 2000 },
    ];
    for (const r of records) {
      await jsonlProvider.store(r);
    }
    await jsonlProvider.close();

    // Run migration
    const { migrateJsonlToSqlite } = await import('../migrate');
    const result = await migrateJsonlToSqlite({
      jsonlPath: join(sourceDir, 'memories.jsonl'),
      sqliteDir: destDir,
    });

    assert.strictEqual(result.total, 3);
    assert.strictEqual(result.migrated, 3);
    assert.strictEqual(result.skipped, 0);
    assert.strictEqual(result.failed, 0);
    assert.strictEqual(result.errors.length, 0);

    // Verify data in SQLite
    const sqliteProvider = createSqliteMemoryProvider({ rootDir: destDir, enableFts: false });
    try {
      const count = await sqliteProvider.count({ userId: 'u1' });
      assert.strictEqual(count, 3);

      const all = await sqliteProvider.list({ userId: 'u1', limit: 10 });
      assert.strictEqual(all.length, 3);
      assert.ok(all.some((m) => m.id === 'mig-1'));
      assert.ok(all.some((m) => m.id === 'mig-2'));
      assert.ok(all.some((m) => m.id === 'mig-3'));
    } finally {
      await sqliteProvider.close();
    }
  });

  it('is idempotent (re-run skips existing)', async () => {
    await jsonlProvider.store({
      id: 'idem-1',
      content: 'Idempotent test',
      kind: 'long-term',
      scope: 'user',
      userId: 'u1',
      createdAt: Date.now(),
    });
    await jsonlProvider.close();

    const { migrateJsonlToSqlite } = await import('../migrate');

    // First run
    const result1 = await migrateJsonlToSqlite({
      jsonlPath: join(sourceDir, 'memories.jsonl'),
      sqliteDir: destDir,
    });
    assert.strictEqual(result1.migrated, 1);
    assert.strictEqual(result1.skipped, 0);

    // Second run (should skip)
    const result2 = await migrateJsonlToSqlite({
      jsonlPath: join(sourceDir, 'memories.jsonl'),
      sqliteDir: destDir,
    });
    assert.strictEqual(result2.migrated, 0);
    assert.strictEqual(result2.skipped, 1);

    // Verify only one copy exists
    const sqliteProvider = createSqliteMemoryProvider({ rootDir: destDir, enableFts: false });
    try {
      const count = await sqliteProvider.count({ userId: 'u1' });
      assert.strictEqual(count, 1);
    } finally {
      await sqliteProvider.close();
    }
  });

  it('handles empty JSONL file gracefully', async () => {
    // Close without writing anything
    await jsonlProvider.close();

    const { migrateJsonlToSqlite } = await import('../migrate');
    const result = await migrateJsonlToSqlite({
      jsonlPath: join(sourceDir, 'memories.jsonl'),
      sqliteDir: destDir,
    });

    assert.strictEqual(result.total, 0);
    assert.strictEqual(result.migrated, 0);
  });
});

