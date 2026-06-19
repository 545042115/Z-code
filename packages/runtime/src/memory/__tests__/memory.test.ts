// @z-assistant/runtime — memory subsystem tests

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { tmpdir } from 'os';
import { join } from 'path';
import { rmSync, mkdirSync, existsSync } from 'fs';
import {
  createJsonlMemoryProvider,
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
import type { MemoryRecord } from '@z-assistant/contracts';

function makeTempDir(): string {
  const dir = join(tmpdir(), `z-assistant-memory-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
