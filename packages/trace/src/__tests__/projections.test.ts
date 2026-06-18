// Tests for the V2 trace projection functions.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { createFileStore, type Store } from '@z-assistant/infra-storage';
import type { AgentRun, AgentSpan, Evaluation } from '@z-assistant/contracts';
import {
  projectRunSummary,
  buildChildCountMap,
  projectSpanNode,
  computeScoreTrend,
  buildBaseline,
  diffBaseline,
  projectToolUsage,
  projectSkillUsage,
  projectVariantStats,
  listRunSummaries,
  listSpanNodes,
  readRunEvents,
  listToolUsage,
  listSkillUsage,
} from '../projections';

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

async function withStore<T>(fn: (store: Store, root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'z-proj-'));
  try {
    const store = await createFileStore({ rootDir: root });
    return await fn(store, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// ── Pure projection functions ─────────────────────────────────────────

test('projectRunSummary: counts spans and error spans', () => {
  const r = mkRun({ id: 'r1', status: 'success' });
  const spans = [mkSpan('r1', { status: 'ok' }), mkSpan('r1', { status: 'error' })];
  const s = projectRunSummary(r, spans);
  assert.strictEqual(s.id, 'r1');
  assert.strictEqual(s.spanCount, 2);
  assert.strictEqual(s.errorSpanCount, 1);
});

test('buildChildCountMap + projectSpanNode: childCount from parentSpanId', () => {
  const spans = [
    mkSpan('r1', { id: 'p', name: 'planner' }),
    mkSpan('r1', { id: 'c1', parentSpanId: 'p', name: 'llm' }),
    mkSpan('r1', { id: 'c2', parentSpanId: 'p', name: 'tool' }),
  ];
  const map = buildChildCountMap(spans);
  assert.strictEqual(map.get('p'), 2);
  const pNode = projectSpanNode(spans[0], map);
  const cNode = projectSpanNode(spans[1], map);
  assert.strictEqual(pNode.childCount, 2);
  assert.strictEqual(cNode.childCount, 0);
});

test('projectSpanNode: marks hasError + errorCode', () => {
  const map = new Map();
  const n = projectSpanNode(
    mkSpan('r1', { status: 'error', error: { code: '2002', message: 'denied' } }),
    map,
  );
  assert.strictEqual(n.hasError, true);
  assert.strictEqual(n.errorCode, '2002');
});

test('computeScoreTrend: sorts by ts', () => {
  const evals: Evaluation[] = [
    { id: 'e3', runId: 'r', benchmarkId: 'b', scores: {}, total: 70, pass: true, timestamp: 3000, durationMs: 1 },
    { id: 'e1', runId: 'r', benchmarkId: 'b', scores: {}, total: 90, pass: true, timestamp: 1000, durationMs: 1 },
    { id: 'e2', runId: 'r', benchmarkId: 'b', scores: {}, total: 20, pass: false, timestamp: 2000, durationMs: 1 },
  ];
  const trend = computeScoreTrend(evals);
  assert.strictEqual(trend.length, 3);
  assert.strictEqual(trend[0].timestamp, 1000);
  assert.strictEqual(trend[2].timestamp, 3000);
  // Caller can take the last N for display
  const recent = trend.slice(-2);
  assert.strictEqual(recent.length, 2);
  assert.strictEqual(recent[0].timestamp, 2000);
  assert.strictEqual(recent[1].timestamp, 3000);
});

test('buildBaseline: id format and snapshot', () => {
  const b = buildBaseline({ benchmarkId: 'b1', name: 'v0.3', evaluations: [] });
  assert.strictEqual(b.id, 'b1:v0.3');
  assert.strictEqual(b.benchmarkId, 'b1');
  assert.strictEqual(b.createdAt > 0, true);
});

test('diffBaseline: returns empty aggregates for missing baseline', () => {
  const r = diffBaseline({ baseline: undefined, currentList: [] });
  assert.strictEqual(r.deltas.length, 0);
  assert.strictEqual(r.baseline.count, 0);
  assert.strictEqual(r.current.count, 0);
});

test('diffBaseline: returns aggregate + delta when baseline present', () => {
  const baseline = buildBaseline({
    benchmarkId: 'b1',
    name: 'v0.3',
    evaluations: [
      { id: 'e1', runId: 'r', benchmarkId: 'b1', scores: {}, total: 80, pass: true, timestamp: 1, durationMs: 1 },
    ],
  });
  const current: Evaluation[] = [
    { id: 'e2', runId: 'r', benchmarkId: 'b1', scores: {}, total: 40, pass: false, timestamp: 2, durationMs: 1 },
  ];
  const r = diffBaseline({ baseline, currentList: current });
  assert.strictEqual(r.baseline.count, 1);
  assert.strictEqual(r.current.count, 1);
  const passDelta = r.deltas.find((d) => d.metric === 'passRate');
  assert.ok(passDelta);
  assert.ok(passDelta!.diff < 0);
});

test('projectToolUsage: aggregates per-tool stats', () => {
  const r = mkRun({ id: 'r1' });
  const spans = [
    mkSpan('r1', { type: 'tool', name: 'fs', status: 'ok', duration: 100 }),
    mkSpan('r1', { type: 'tool', name: 'fs', status: 'ok', duration: 200 }),
    mkSpan('r1', { type: 'tool', name: 'net', status: 'error', duration: 50 }),
  ];
  const rows = projectToolUsage([r], new Map([[r.id, spans]]));
  const fs = rows.find((t) => t.name === 'fs');
  const net = rows.find((t) => t.name === 'net');
  assert.ok(fs);
  assert.ok(net);
  assert.strictEqual(fs!.calls, 2);
  assert.strictEqual(fs!.successRate, 1);
  assert.strictEqual(net!.calls, 1);
  assert.strictEqual(net!.successRate, 0);
});

test('projectSkillUsage: aggregates per-skill stats', () => {
  const r = mkRun({ id: 'r1' });
  const spans = [
    mkSpan('r1', { type: 'skill', name: 'refactor', status: 'ok' }),
    mkSpan('r1', { type: 'skill', name: 'refactor', status: 'error' }),
  ];
  const rows = projectSkillUsage([r], new Map([[r.id, spans]]));
  const refactor = rows.find((s) => s.name === 'refactor');
  assert.ok(refactor);
  assert.strictEqual(refactor!.hits, 2);
  assert.strictEqual(refactor!.successRate, 0.5);
});

test('projectVariantStats: returns per-variant aggregates from tagged runs', () => {
  const variantId = 'v-control';
  const candidate = {
    id: 'p:d',
    agentName: 'p',
    name: 'd',
    variants: [
      { id: variantId, label: 'control', content: 'x', createdAt: 1 },
      { id: 'v-a', label: 'A', content: 'y', createdAt: 1 },
    ],
    activeVariantId: variantId,
    createdAt: 1,
    updatedAt: 1,
  };
  const runs = [
    mkRun({ id: 'rc0', tags: [`variant:${variantId}`], status: 'success' }),
    mkRun({ id: 'rc1', tags: [`variant:${variantId}`], status: 'success' }),
    mkRun({ id: 'ra0', tags: ['variant:v-a'], status: 'failed' }),
  ];
  const stats = projectVariantStats({ candidate, runs });
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

// ── Store-backed projections ──────────────────────────────────────────

test('listRunSummaries: returns summary with spanCount + errorSpanCount', async () => {
  await withStore(async (store) => {
    const r = mkRun({ id: 'r1', status: 'success' });
    await store.runs.insert(r);
    await store.spans.insert(mkSpan(r.id, { id: 's1', status: 'ok' }));
    await store.spans.insert(mkSpan(r.id, { id: 's2', status: 'error' }));

    const runs = await listRunSummaries(store);
    assert.strictEqual(runs.length, 1);
    assert.strictEqual(runs[0].spanCount, 2);
    assert.strictEqual(runs[0].errorSpanCount, 1);
  });
});

test('listRunSummaries: filters by status', async () => {
  await withStore(async (store) => {
    await store.runs.insert(mkRun({ id: 'a', status: 'success' }));
    await store.runs.insert(mkRun({ id: 'b', status: 'failed' }));
    const out = await listRunSummaries(store, { status: 'failed' });
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].id, 'b');
  });
});

test('listSpanNodes: builds childCount from parentSpanId', async () => {
  await withStore(async (store) => {
    const r = mkRun({ id: 'r1' });
    await store.runs.insert(r);
    await store.spans.insert(mkSpan(r.id, { id: 'parent', name: 'planner' }));
    await store.spans.insert(mkSpan(r.id, { id: 'c1', parentSpanId: 'parent', name: 'llm' }));
    await store.spans.insert(mkSpan(r.id, { id: 'c2', parentSpanId: 'parent', name: 'tool' }));
    const nodes = await listSpanNodes(store, 'r1');
    const p = nodes.find((n) => n.id === 'parent');
    const c = nodes.find((n) => n.id === 'c1');
    assert.strictEqual(p?.childCount, 2);
    assert.strictEqual(c?.childCount, 0);
  });
});

test('readRunEvents: reads events in ts order from JSONL', async () => {
  await withStore(async (store, root) => {
    const r = mkRun({ id: 'r1' });
    await store.runs.insert(r);
    const { appendFile } = await import('fs/promises');
    const f = join(root, 'traces', 'r1.jsonl');
    await appendFile(f, JSON.stringify({ ts: 1, name: 'first' }) + '\n');
    await appendFile(f, JSON.stringify({ ts: 2, name: 'second', attributes: { k: 'v' } }) + '\n');
    const evs = await readRunEvents(store, 'r1');
    assert.strictEqual(evs.length, 2);
    assert.strictEqual(evs[0].name, 'first');
    assert.strictEqual(evs[1].attributes?.k, 'v');
  });
});

test('listToolUsage: aggregates per-tool stats across runs', async () => {
  await withStore(async (store) => {
    const r = mkRun({ id: 'r1', startTime: Date.now() - 1000 });  // recent
    await store.runs.insert(r);
    await store.spans.insert(mkSpan(r.id, { id: 's1', startTime: Date.now() - 1000, type: 'tool', name: 'fs', status: 'ok', duration: 100 }));
    await store.spans.insert(mkSpan(r.id, { id: 's2', startTime: Date.now() - 1000, type: 'tool', name: 'fs', status: 'ok', duration: 200 }));
    await store.spans.insert(mkSpan(r.id, { id: 's3', startTime: Date.now() - 1000, type: 'tool', name: 'net', status: 'error', duration: 50 }));
    const rows = await listToolUsage(store);
    const fs = rows.find((t) => t.name === 'fs');
    const net = rows.find((t) => t.name === 'net');
    assert.ok(fs);
    assert.ok(net);
    assert.strictEqual(fs!.calls, 2);
    assert.strictEqual(net!.calls, 1);
  });
});

test('listSkillUsage: aggregates per-skill stats across runs', async () => {
  await withStore(async (store) => {
    const r = mkRun({ id: 'r1', startTime: Date.now() - 1000 });  // recent
    await store.runs.insert(r);
    await store.spans.insert(mkSpan(r.id, { id: 's1', startTime: Date.now() - 1000, type: 'skill', name: 'refactor', status: 'ok' }));
    await store.spans.insert(mkSpan(r.id, { id: 's2', startTime: Date.now() - 1000, type: 'skill', name: 'refactor', status: 'error' }));
    const rows = await listSkillUsage(store);
    const refactor = rows.find((s) => s.name === 'refactor');
    assert.ok(refactor);
    assert.strictEqual(refactor!.hits, 2);
    assert.strictEqual(refactor!.successRate, 0.5);
  });
});
