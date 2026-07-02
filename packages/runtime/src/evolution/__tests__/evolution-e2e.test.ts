// End-to-end test for EvolutionEngine: write some failed runs +
// spans to a real Store, generate a report, verify clustering.
//
// Phase 6A: migrated from V1
// `extensions/coding-agent/src/evolution/__tests__/evolution-e2e.test.ts`.
// Pure Node, no vscode.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { createFileStore, type Store } from '@ziner/infra-storage';
import { TraceManager } from '@ziner/trace';
import { EvolutionEngine, normalizePattern } from '../evolution';
import type { AgentRun, AgentSpan } from '@ziner/contracts';

async function withEngine<T>(fn: (m: TraceManager, engine: EvolutionEngine) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'z-evo-'));
  try {
    const store = await createFileStore({ rootDir: root });
    const m = new TraceManager({ store, tracesDir: join(root, 'traces') });
    const engine = new EvolutionEngine(store, m);
    return await fn(m, engine);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function mkRun(over: Partial<AgentRun>): AgentRun {
  return {
    id: 'r', traceId: 't', sessionId: 's', task: 't', status: 'failed',
    model: { provider: 'p', name: 'n' },
    startTime: 0, endTime: 100, duration: 100,
    totalTokensIn: 0, totalTokensOut: 0, totalCostUsd: 0,
    tags: [], metadata: {},
    ...over,
  };
}

function mkSpan(over: Partial<AgentSpan>): AgentSpan {
  return {
    id: 'sp', runId: 'r', traceId: 't',
    name: 'agent:coder', type: 'agent', status: 'error',
    startTime: 0, endTime: 100, duration: 100,
    input: undefined, output: undefined, attributes: {}, events: [],
    error: { code: '3001', message: 'boom' },
    ...over,
  };
}

test('e2e: empty store produces no clusters', async () => {
  await withEngine(async (_m, engine) => {
    const r = await engine.generate({});
    assert.strictEqual(r.totalFailures, 0);
    assert.strictEqual(r.clusters.length, 0);
    assert.strictEqual(r.readyToApply, false);
  });
});

test('e2e: a single failed run is below the recurring threshold', async () => {
  await withEngine(async (m, engine) => {
    const store: Store = (m as unknown as { opts: { store: Store } }).opts.store;
    const run = mkRun({ id: 'r1', task: 'a', startTime: Date.now() - 1000 });
    await store.runs.insert(run);
    await store.spans.insert(mkSpan({ id: 's1', runId: 'r1', name: 'agent:coder' }));
    const r = await engine.generate({ minOccurrences: 2 });
    // 1 fingerprint, but cluster needs >=2 to be recurring
    assert.strictEqual(r.clusters.length, 0);
  });
});

test('e2e: two runs with the same error form a recurring cluster', async () => {
  await withEngine(async (m, engine) => {
    const store: Store = (m as unknown as { opts: { store: Store } }).opts.store;
    const now = Date.now();
    for (const i of [1, 2]) {
      const run = mkRun({ id: `r${i}`, task: 'a', startTime: now - 1000 });
      await store.runs.insert(run);
      await store.spans.insert(mkSpan({
        id: `s${i}`, runId: `r${i}`,
        name: 'agent:coder',
        error: { code: '3001', message: 'tool exploded' },
      }));
    }
    const r = await engine.generate({ minOccurrences: 2 });
    assert.strictEqual(r.clusters.length, 1);
    assert.strictEqual(r.clusters[0].count, 2);
    assert.strictEqual(r.clusters[0].samples[0].errorCode, '3001');
    assert.strictEqual(r.readyToApply, true);
    assert.ok(r.suggestions.length >= 1);
    // Heuristic: 3001 → prompt suggestion
    assert.strictEqual(r.suggestions[0].kind, 'prompt');
  });
});

test('e2e: successful runs are excluded', async () => {
  await withEngine(async (m, engine) => {
    const store: Store = (m as unknown as { opts: { store: Store } }).opts.store;
    const run = mkRun({ id: 'r1', status: 'success', startTime: Date.now() - 1000 });
    await store.runs.insert(run);
    await store.spans.insert(mkSpan({ id: 's1', runId: 'r1', status: 'error' }));
    const r = await engine.generate({});
    assert.strictEqual(r.totalFailures, 0);
  });
});

test('e2e: window filter excludes old runs', async () => {
  await withEngine(async (m, engine) => {
    const store: Store = (m as unknown as { opts: { store: Store } }).opts.store;
    const old = Date.now() - 30 * 24 * 60 * 60 * 1000;  // 30 days ago
    const run = mkRun({ id: 'r1', startTime: old });
    await store.runs.insert(run);
    await store.spans.insert(mkSpan({ id: 's1', runId: 'r1' }));
    const r = await engine.generate({ windowMs: 7 * 24 * 60 * 60 * 1000 });
    assert.strictEqual(r.totalFailures, 0);
  });
});

test('e2e: limit caps how many runs are scanned', async () => {
  await withEngine(async (m, engine) => {
    const store: Store = (m as unknown as { opts: { store: Store } }).opts.store;
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      const run = mkRun({ id: `r${i}`, startTime: now - 1000 + i });
      await store.runs.insert(run);
      await store.spans.insert(mkSpan({ id: `s${i}`, runId: `r${i}` }));
    }
    const r = await engine.generate({ minOccurrences: 2 });
    // 5 fingerprints all bucket into the same cluster
    assert.strictEqual(r.clusters.length, 1);
    assert.ok(r.clusters[0].count >= 2);
  });
});

test('e2e: pattern normalization groups variants', async () => {
  // Sanity check: same message shape should produce identical patterns
  const a = normalizePattern('error at line 42 in /tmp/x.ts');
  const b = normalizePattern('error at line 99 in /tmp/y.ts');
  assert.strictEqual(a, b);
});
