// @z-assistant/runtime — Knowledge subsystem tests

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { createInMemoryVectorStore } from '../storage/vector-store';
import { createLocalEmbeddingProvider } from '../embedding';
import type { IMemoryProvider } from '@z-assistant/contracts';
import { createJsonlMemoryProvider } from '../memory/provider';
import { ProjectKnowledgeBase } from '../knowledge/project';
import { UserKnowledgeBase } from '../knowledge/user';
import { DocumentKnowledgeBase, DocumentChunk } from '../knowledge/document';
import { promises as fsp, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

function createTestProvider(): IMemoryProvider {
  const dir = join(tmpdir(), `z-knowledge-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  return createJsonlMemoryProvider({
    rootDir: dir,
    vectorStore: createInMemoryVectorStore(),
    embedding: createLocalEmbeddingProvider({ dimensions: 64 }),
  });
}

// ── Project Knowledge ──────────────────────────────────────────────────

describe('ProjectKnowledgeBase', () => {
  let memory: IMemoryProvider;
  let kb: ProjectKnowledgeBase;

  beforeEach(async () => {
    memory = createTestProvider();
    kb = new ProjectKnowledgeBase(memory);
  });

  it('learn and get knowledge', async () => {
    await kb.learn('proj-1', {
      key: 'build-system',
      description: 'This project uses npm workspaces with TypeScript project references.',
      payload: { tool: 'npm', version: '11' },
      tags: ['build', 'typescript'],
      confidence: 0.9,
    });
    const result = await kb.get('proj-1', 'build-system');
    assert.ok(result);
    assert.strictEqual(result.key, 'build-system');
    assert.strictEqual(result.confidence, 0.9);
    assert.ok(result.learnedAt > 0);
  });

  it('search knowledge by query', async () => {
    await kb.learn('proj-1', {
      key: 'testing', description: 'Uses vitest for unit tests.',
      payload: { framework: 'vitest' }, tags: [], confidence: 0.8,
    });
    await kb.learn('proj-1', {
      key: 'linting', description: 'Uses ESLint with TypeScript rules.',
      payload: { tool: 'eslint' }, tags: [], confidence: 0.7,
    });
    const results = await kb.search('proj-1', 'uses vitest');
    assert.ok(results.length >= 1);
    assert.ok(results.some((r) => r.key === 'testing'));
  });

  it('list all knowledge for a project', async () => {
    await kb.learn('proj-1', { key: 'a', description: 'A', payload: {}, tags: [], confidence: 1 });
    await kb.learn('proj-1', { key: 'b', description: 'B', payload: {}, tags: [], confidence: 1 });
    const list = await kb.list('proj-1');
    assert.strictEqual(list.length, 2);
  });

  it('forget removes knowledge', async () => {
    await kb.learn('proj-1', { key: 'temp', description: 'Temp', payload: {}, tags: [], confidence: 1 });
    assert.ok(await kb.get('proj-1', 'temp'));
    await kb.forget('proj-1', 'temp');
    assert.strictEqual(await kb.get('proj-1', 'temp'), undefined);
  });
});

// ── User Knowledge ─────────────────────────────────────────────────────

describe('UserKnowledgeBase', () => {
  let memory: IMemoryProvider;
  let kb: UserKnowledgeBase;

  beforeEach(async () => {
    memory = createTestProvider();
    kb = new UserKnowledgeBase(memory);
  });

  it('learn and get user knowledge', async () => {
    await kb.learn('user-1', {
      key: 'preferred-language',
      description: 'User prefers TypeScript for all projects.',
      payload: { language: 'TypeScript' },
      category: 'preference',
      confidence: 0.95,
    });
    const result = await kb.get('user-1', 'preference', 'preferred-language');
    assert.ok(result);
    assert.strictEqual(result.key, 'preferred-language');
    assert.strictEqual(result.category, 'preference');
  });

  it('search user knowledge', async () => {
    await kb.learn('user-1', {
      key: 'expertise-react', description: 'Expert in React and Next.js.',
      payload: { level: 'expert' }, category: 'expertise', confidence: 0.9,
    });
    await kb.learn('user-1', {
      key: 'expertise-python', description: 'Knows Python.',
      payload: { level: 'intermediate' }, category: 'expertise', confidence: 0.6,
    });
    const results = await kb.search('user-1', 'React');
    assert.ok(results.length >= 1);
    assert.ok(results.some((r) => r.key === 'expertise-react'));
  });

  it('list filters by category', async () => {
    await kb.learn('user-1', { key: 'lang', description: 'Likes TS', payload: {}, category: 'preference', confidence: 1 });
    await kb.learn('user-1', { key: 'expert-ts', description: 'TS expert', payload: {}, category: 'expertise', confidence: 1 });
    const prefs = await kb.list('user-1', 'preference');
    assert.strictEqual(prefs.length, 1);
    assert.strictEqual(prefs[0].category, 'preference');
    const all = await kb.list('user-1');
    assert.strictEqual(all.length, 2);
  });

  it('forget removes user knowledge', async () => {
    await kb.learn('user-1', { key: 'temp', description: 'Temp', payload: {}, category: 'preference', confidence: 1 });
    assert.ok(await kb.get('user-1', 'preference', 'temp'));
    await kb.forget('user-1', 'preference', 'temp');
    assert.strictEqual(await kb.get('user-1', 'preference', 'temp'), undefined);
  });
});

// ── Document Knowledge ─────────────────────────────────────────────────

describe('DocumentKnowledgeBase', () => {
  let memory: IMemoryProvider;
  let kb: DocumentKnowledgeBase;

  beforeEach(async () => {
    memory = createTestProvider();
    kb = new DocumentKnowledgeBase(memory);
  });

  it('index and search document chunks', async () => {
    await kb.indexChunk('proj-1', {
      chunkId: '1',
      documentId: 'doc-1',
      title: 'Readme',
      content: 'This project is a CLI tool for TypeScript projects.',
      section: 'Overview',
      startOffset: 1,
      endOffset: 3,
    });
    await kb.indexChunk('proj-1', {
      chunkId: '2',
      documentId: 'doc-1',
      title: 'Readme',
      content: 'Build with npm run build.',
      section: 'Usage',
      startOffset: 5,
      endOffset: 6,
    });
    const results = await kb.search('proj-1', 'CLI tool');
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].chunkId, '1');
  });

  it('get document returns ordered chunks', async () => {
    await kb.indexChunk('proj-1', { chunkId: 'b', documentId: 'doc-2', title: 'Guide', content: 'B', startOffset: 10, endOffset: 20 });
    await kb.indexChunk('proj-1', { chunkId: 'a', documentId: 'doc-2', title: 'Guide', content: 'A', startOffset: 1, endOffset: 9 });
    const chunks = await kb.getDocument('proj-1', 'doc-2');
    assert.strictEqual(chunks.length, 2);
    assert.strictEqual(chunks[0].chunkId, 'a'); // sorted by startOffset
    assert.strictEqual(chunks[1].chunkId, 'b');
  });

  it('remove document deletes all its chunks', async () => {
    await kb.indexChunk('proj-1', { chunkId: '1', documentId: 'doc-3', title: 'Doc', content: 'C1' });
    await kb.indexChunk('proj-1', { chunkId: '2', documentId: 'doc-3', title: 'Doc', content: 'C2' });
    await kb.indexChunk('proj-1', { chunkId: 'x', documentId: 'other', title: 'Other', content: 'X' });
    const removed = await kb.removeDocument('proj-1', 'doc-3');
    assert.strictEqual(removed, 2);
    const remainingList = await memory.list({ kind: 'semantic', projectId: 'proj-1', limit: 10 });
    assert.strictEqual(remainingList.length, 1);
    const remaining: DocumentChunk[] = remainingList
      .map((r) => (r.payload as { docChunk?: DocumentChunk })?.docChunk)
      .filter((c): c is DocumentChunk => !!c);
    assert.strictEqual(remaining.length, 1);
    assert.strictEqual(remaining[0].documentId, 'other');
  });
});
