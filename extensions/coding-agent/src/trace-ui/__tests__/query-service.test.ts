// Unit tests for QueryService (caching + projection logic).
// Note: TracePanel itself requires a real vscode runtime; we test the
// query layer in isolation, which is the bulk of the UI logic.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { QueryService } from '../query-service';
import { createFileStore, type Store } from '../../infra/storage';
import type { AgentRun, AgentSpan, Evaluation } from '../../contracts';

async function withService<T>(fn: (svc: QueryService, store: Store, root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'z-qs-'));
  try {
    const store = await createFileStore({ rootDir: root });
    const svc = new QueryService(store);
    return await fn(svc, store, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function mkRun(over: Partial<AgentRun> = {}): AgentRun {
  return {
    id: 'r-' + Math.random().toString(36).slice(2),
    traceId: 't-' + Math.random().toString(36).slice(2),
    sessionId: 's',
    task: 'do something',
    model: { provider: 'openai', name: 'gpt-4o' },
    startTime: 1000,
    status: 'success',
    totalTokensIn: 0,
    totalTokensOut: 0,
    totalCostUsd: 0,
    tags: [],
    metadata: {},
    ...over,
  };
}

function mkSpan(runId: string, over: Partial<AgentSpan> = {}): AgentSpan {
  return {
    id: 's-' + Math.random().toString(36).slice(2),
    traceId: 't',
    runId,
    name: 'tool:edit',
    type: 'tool',
    startTime: 1000,
    endTime: 1500,
    status: 'ok',
    attributes: {},
    events: [],
    ...over,
  };
}

// ── listRuns ──────────────────────────────────────────────────────────

test('listRuns: returns summary with spanCount and errorSpanCount', async () => {
  await withService(async (svc, store) => {
    const r = mkRun({ id: 'r1', status: 'success' });
    await store.runs.insert(r);
    await store.spans.insert(mkSpan(r.id, { id: 's1', status: 'ok' }));
    await store.spans.insert(mkSpan(r.id, { id: 's2', status: 'error' }));

    const runs = await svc.listRuns();
    assert.strictEqual(runs.length, 1);
    assert.strictEqual(runs[0].spanCount, 2);
    assert.strictEqual(runs[0].errorSpanCount, 1);
    assert.strictEqual(runs[0].task, 'do something');
  });
});

test('listRuns: filters by status', async () => {
  await withService(async (svc, store) => {
    await store.runs.insert(mkRun({ id: 'a', status: 'success' }));
    await store.runs.insert(mkRun({ id: 'b', status: 'failed' }));
    const out = await svc.listRuns({ status: 'failed' });
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].id, 'b');
  });
});

// ── getRun ────────────────────────────────────────────────────────────

test('getRun: caches result', async () => {
  await withService(async (svc, store) => {
    await store.runs.insert(mkRun({ id: 'r1', task: 'cached' }));
    const a = await svc.getRun('r1');
    const b = await svc.getRun('r1');
    assert.strictEqual(a, b);  // same reference => cached
  });
});

test('getRun: returns undefined for missing', async () => {
  await withService(async (svc) => {
    assert.strictEqual(await svc.getRun('nope'), undefined);
  });
});

// ── listSpanNodes ─────────────────────────────────────────────────────

test('listSpanNodes: builds childCount from parentSpanId', async () => {
  await withService(async (svc, store) => {
    const r = mkRun({ id: 'r1' });
    await store.runs.insert(r);
    const parent = mkSpan(r.id, { id: 'parent', name: 'planner' });
    const c1 = mkSpan(r.id, { id: 'c1', parentSpanId: 'parent', name: 'llm' });
    const c2 = mkSpan(r.id, { id: 'c2', parentSpanId: 'parent', name: 'tool' });
    await store.spans.insert(parent);
    await store.spans.insert(c1);
    await store.spans.insert(c2);

    const nodes = await svc.listSpanNodes('r1');
    const p = nodes.find((n) => n.id === 'parent');
    const c = nodes.find((n) => n.id === 'c1');
    assert.strictEqual(p?.childCount, 2);
    assert.strictEqual(c?.childCount, 0);
    assert.strictEqual(c?.parentSpanId, 'parent');
  });
});

test('listSpanNodes: marks hasError and errorCode', async () => {
  await withService(async (svc, store) => {
    const r = mkRun({ id: 'r1' });
    await store.runs.insert(r);
    await store.spans.insert(mkSpan(r.id, {
      id: 's1', status: 'error', error: { code: '2002', message: 'denied' },
    }));
    const nodes = await svc.listSpanNodes('r1');
    assert.strictEqual(nodes[0].hasError, true);
    assert.strictEqual(nodes[0].errorCode, '2002');
  });
});

test('listSpanNodes: counts events', async () => {
  await withService(async (svc, store) => {
    const r = mkRun({ id: 'r1' });
    await store.runs.insert(r);
    await store.spans.insert(mkSpan(r.id, {
      id: 's1',
      events: [
        { ts: 1, name: 'a' },
        { ts: 2, name: 'b' },
        { ts: 3, name: 'c' },
      ],
    }));
    const nodes = await svc.listSpanNodes('r1');
    assert.strictEqual(nodes[0].eventCount, 3);
  });
});

// ── getSpan ───────────────────────────────────────────────────────────

test('getSpan: returns full record (no projection)', async () => {
  await withService(async (svc, store) => {
    const r = mkRun({ id: 'r1' });
    await store.runs.insert(r);
    await store.spans.insert(mkSpan(r.id, {
      id: 's1', input: { x: 1 }, output: { y: 2 }, events: [{ ts: 1, name: 'go' }],
    }));
    const s = await svc.getSpan('s1');
    assert.deepStrictEqual(s?.input, { x: 1 });
    assert.deepStrictEqual(s?.output, { y: 2 });
    assert.strictEqual(s?.events[0].name, 'go');
  });
});

// ── readEvents ────────────────────────────────────────────────────────

test('readEvents: streams events in order from JSONL', async () => {
  await withService(async (svc, store, root) => {
    // We have to write events directly to the file; use the same layout
    // that jsonl-store expects. Since QueryService reads from store,
    // we use a real Run.
    const r = mkRun({ id: 'r1' });
    await store.runs.insert(r);
    const { appendFile } = await import('fs/promises');
    const f = join(root, 'traces', 'r1.jsonl');
    await appendFile(f, JSON.stringify({ ts: 1, name: 'first' }) + '\n');
    await appendFile(f, JSON.stringify({ ts: 2, name: 'second', attributes: { k: 'v' } }) + '\n');
    const evs = await svc.readEvents('r1');
    assert.strictEqual(evs.length, 2);
    assert.strictEqual(evs[0].name, 'first');
    assert.strictEqual(evs[1].attributes?.k, 'v');
  });
});

// ── subscribe / invalidate ────────────────────────────────────────────

test('subscribe: receives invalidation keys', async () => {
  await withService(async (svc) => {
    const got: string[] = [];
    svc.subscribe((k) => got.push(k));
    svc.invalidate('runs:*', 'spans:r1');
    assert.deepStrictEqual(got, ['runs:*,spans:r1']);
  });
});

test('unsubscribe: stops receiving notifications', async () => {
  await withService(async (svc) => {
    const got: string[] = [];
    const unsub = svc.subscribe((k) => got.push(k));
    svc.invalidate('a');
    unsub();
    svc.invalidate('b');
    assert.deepStrictEqual(got, ['a']);
  });
});

test('invalidate: drops the cached value', async () => {
  await withService(async (svc, store) => {
    await store.runs.insert(mkRun({ id: 'r1', task: 'v1' }));
    const a = await svc.getRun('r1');
    assert.strictEqual(a?.task, 'v1');
    // Update directly in store
    await store.runs.update('r1', { task: 'v2' });
    svc.invalidate('run:r1');
    const b = await svc.getRun('r1');
    assert.strictEqual(b?.task, 'v2');
  });
});

test('clear: drops everything', async () => {
  await withService(async (svc, store) => {
    await store.runs.insert(mkRun({ id: 'r1' }));
    await svc.getRun('r1');
    svc.clear();
    // After clear, getRun should hit the store again
    const got = await svc.getRun('r1');
    assert.ok(got);
  });
});

test('onRunUpdated: invalidates run + spans + events caches', async () => {
  await withService(async (svc) => {
    let received: string = '';
    svc.subscribe((k) => { received = k; });
    await svc.onRunUpdated('r1');
    assert.ok(received.length > 0);
    assert.ok(received.includes('run:r1'), `expected run:r1 in ${received}`);
    assert.ok(received.includes('spans:r1'), `expected spans:r1 in ${received}`);
    assert.ok(received.includes('events:r1'), `expected events:r1 in ${received}`);
  });
});

// ── Baselines (Phase 4) ──────────────────────────────────────────────

test('baselines: createBaseline snapshots current evals', async () => {
  await withService(async (svc, store) => {
    const r = mkRun({ id: 'r1' });
    await store.runs.insert(r);
    const e1 = { id: 'e1', runId: 'r1', benchmarkId: 'b1', scores: {}, total: 80, pass: true, timestamp: 1, durationMs: 100 };
    const e2 = { id: 'e2', runId: 'r1', benchmarkId: 'b1', scores: {}, total: 40, pass: false, timestamp: 2, durationMs: 200 };
    await store.evals.insert(e1 as Evaluation);
    await store.evals.insert(e2 as Evaluation);
    const b = await svc.createBaseline({ benchmarkId: 'b1', name: 'v0.3' });
    assert.strictEqual(b.id, 'b1:v0.3');
    assert.strictEqual(b.evaluations.length, 2);
    const listed = await svc.listBaselines({ benchmarkId: 'b1' });
    assert.strictEqual(listed.length, 1);
    assert.strictEqual(listed[0].id, 'b1:v0.3');
  });
});

test('baselines: compareToBaseline returns baseline + current deltas', async () => {
  await withService(async (svc, store) => {
    const r = mkRun({ id: 'r1' });
    await store.runs.insert(r);
    await store.evals.insert({ id: 'e1', runId: 'r1', benchmarkId: 'b1', scores: {}, total: 50, pass: true, timestamp: 1000, durationMs: 100 });
    const b = await svc.createBaseline({ benchmarkId: 'b1', name: 'v0.3' });
    // Add a new failing eval after baseline
    await store.evals.insert({ id: 'e2', runId: 'r1', benchmarkId: 'b1', scores: {}, total: 20, pass: false, timestamp: Date.now(), durationMs: 500 });
    const cmp = await svc.compareToBaseline({ baselineId: b.id });
    assert.strictEqual(cmp.baseline.count, 1);
    assert.strictEqual(cmp.current.count, 1);
    const passRate = cmp.deltas.find((d) => d.metric === 'passRate');
    assert.ok(passRate);
    assert.ok(passRate!.diff < 0);  // current is 0, baseline was 1
  });
});

test('baselines: deleteBaseline removes', async () => {
  await withService(async (svc, store) => {
    await store.evals.insert({ id: 'e1', runId: 'r1', benchmarkId: 'b1', scores: {}, total: 50, pass: true, timestamp: 1, durationMs: 100 });
    const b = await svc.createBaseline({ benchmarkId: 'b1', name: 'x' });
    await svc.deleteBaseline(b.id);
    const listed = await svc.listBaselines();
    assert.strictEqual(listed.length, 0);
  });
});

// ── Candidates (Phase 5) ─────────────────────────────────────────────

test('candidates: upsertCandidate + listCandidates', async () => {
  await withService(async (svc) => {
    const c = await svc.upsertCandidate({
      id: 'planner:default',
      agentName: 'planner',
      name: 'planner-default',
      variants: [{ id: 'v1', label: 'control', content: 'You are a planner.', createdAt: Date.now() }],
      activeVariantId: 'v1',
    });
    assert.strictEqual(c.id, 'planner:default');
    const list = await svc.listCandidates();
    assert.strictEqual(list.length, 1);
  });
});

test('candidates: variantStats returns per-variant aggregates', async () => {
  await withService(async (svc, store) => {
    const variantId = 'v-control';
    await svc.upsertCandidate({
      id: 'p:d',
      agentName: 'p',
      name: 'd',
      variants: [
        { id: variantId, label: 'control', content: 'x', createdAt: 1 },
        { id: 'v-a', label: 'A', content: 'y', createdAt: 1 },
      ],
      activeVariantId: variantId,
    });
    // 2 successful runs on control
    for (let i = 0; i < 2; i++) {
      await store.runs.insert(mkRun({ id: `rc${i}`, tags: [`variant:${variantId}`], status: 'success' }));
    }
    // 1 failed run on A
    await store.runs.insert(mkRun({ id: 'ra0', tags: ['variant:v-a'], status: 'failed' }));

    const stats = await svc.variantStats('p:d');
    assert.strictEqual(stats.length, 2);
    const control = stats.find((s) => s.variantId === variantId);
    const a = stats.find((s) => s.variantId === 'v-a');
    assert.ok(control);
    assert.ok(a);
    assert.strictEqual(control!.runCount, 2);
    assert.strictEqual(control!.passRate, 1);
    assert.strictEqual(a!.runCount, 1);
    assert.strictEqual(a!.passRate, 0);
  });
});

// ── Optimizer stats (Phase 5) ────────────────────────────────────────

test('toolUsage: aggregates per-tool stats from spans', async () => {
  await withService(async (svc, store) => {
    const r = mkRun({ id: 'r1', startTime: Date.now() - 1000 });  // recent
    await store.runs.insert(r);
    await store.spans.insert(mkSpan(r.id, { id: 's1', startTime: Date.now() - 1000, type: 'tool', name: 'fs', status: 'ok', duration: 100 }));
    await store.spans.insert(mkSpan(r.id, { id: 's2', startTime: Date.now() - 1000, type: 'tool', name: 'fs', status: 'ok', duration: 200 }));
    await store.spans.insert(mkSpan(r.id, { id: 's3', startTime: Date.now() - 1000, type: 'tool', name: 'net', status: 'error', duration: 50 }));
    const rows = await svc.toolUsage();
    const fs = rows.find((t) => t.name === 'fs');
    const net = rows.find((t) => t.name === 'net');
    assert.ok(fs);
    assert.ok(net);
    assert.strictEqual(fs!.calls, 2);
    assert.strictEqual(fs!.successRate, 1);
    assert.strictEqual(net!.calls, 1);
    assert.strictEqual(net!.successRate, 0);
  });
});

test('skillUsage: aggregates per-skill hit + success', async () => {
  await withService(async (svc, store) => {
    const r = mkRun({ id: 'r1', startTime: Date.now() - 1000 });  // recent
    await store.runs.insert(r);
    await store.spans.insert(mkSpan(r.id, { id: 's1', startTime: Date.now() - 1000, type: 'skill', name: 'refactor', status: 'ok' }));
    await store.spans.insert(mkSpan(r.id, { id: 's2', startTime: Date.now() - 1000, type: 'skill', name: 'refactor', status: 'error' }));
    const rows = await svc.skillUsage();
    const refactor = rows.find((s) => s.name === 'refactor');
    assert.ok(refactor);
    assert.strictEqual(refactor!.hits, 2);
    assert.strictEqual(refactor!.successRate, 0.5);
  });
});
