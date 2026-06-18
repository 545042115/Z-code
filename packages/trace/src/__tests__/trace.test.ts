// Integration tests for TraceManager + RunTracker + Span (V2 trace package).
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, rm } from 'fs/promises';
import { readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { TraceManager } from '../run-tracker';
import { createFileStore, type Store } from '@z-assistant/infra-storage';

async function withManager<T>(fn: (m: TraceManager, store: Store, root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'z-trace-'));
  try {
    const store = await createFileStore({ rootDir: root });
    const m = new TraceManager({ store, tracesDir: join(root, 'traces') });
    return await fn(m, store, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const baseModel = { provider: 'openai', name: 'gpt-4o' };

test('startRun: creates a Run with traceId', async () => {
  await withManager(async (m) => {
    const tracker = await m.startRun({
      task: 'hello',
      model: baseModel,
      sessionId: 's1',
    });
    assert.ok(tracker.id);
    assert.strictEqual(tracker.traceId.length, 32);  // W3C 16-byte hex
    const stored = await m.active();   // still the same
    assert.strictEqual(stored?.id, tracker.id);
    await tracker.finish();
  });
});

test('finish: records endTime / duration / status', async () => {
  await withManager(async (m) => {
    const t = await m.startRun({ task: 'x', model: baseModel, sessionId: 's' });
    await new Promise((r) => setTimeout(r, 5));
    await t.finish();
    const all = await m['opts'].store.runs.list();
    assert.strictEqual(all.length, 1);
    assert.strictEqual(all[0].status, 'success');
    assert.ok(all[0].endTime);
    assert.ok((all[0].duration ?? 0) >= 0);
  });
});

test('finish: error => status failed', async () => {
  await withManager(async (m) => {
    const t = await m.startRun({ task: 'x', model: baseModel, sessionId: 's' });
    await t.finish({ status: 'failed', error: { code: '1001', message: 'rate' } });
    const r = (await m['opts'].store.runs.list())[0];
    assert.strictEqual(r.status, 'failed');
    assert.strictEqual(r.error?.code, '1001');
  });
});

test('startSpan: persists span and is queryable', async () => {
  await withManager(async (m) => {
    const t = await m.startRun({ task: 'x', model: baseModel, sessionId: 's' });
    const s = t.startSpan({ name: 'tool:edit', type: 'tool' });
    s.setInput({ path: 'a.ts' });
    s.setOutput({ ok: true });
    s.end();
    await t.flush();
    const spans = await m['opts'].store.spans.listByRun(t.id);
    assert.strictEqual(spans.length, 1);
    assert.strictEqual(spans[0].name, 'tool:edit');
    assert.strictEqual(spans[0].type, 'tool');
    assert.deepStrictEqual(spans[0].output, { ok: true });
    assert.strictEqual(spans[0].status, 'ok');
    await t.finish();
  });
});

test('Span: addEvent appends to events[]', async () => {
  await withManager(async (m) => {
    const t = await m.startRun({ task: 'x', model: baseModel, sessionId: 's' });
    const s = t.startSpan({ name: 'planner', type: 'planner' });
    s.addEvent('plan.start');
    s.addEvent('plan.chunk', { tokens: 100 });
    s.end();
    await t.flush();
    const got = (await m['opts'].store.spans.listByRun(t.id))[0];
    assert.strictEqual(got.events.length, 2);
    assert.strictEqual(got.events[1].attributes?.['tokens'], 100);
    await t.finish();
  });
});

test('Span: addTokens updates run-level counters', async () => {
  await withManager(async (m) => {
    const t = await m.startRun({ task: 'x', model: baseModel, sessionId: 's' });
    const s = t.startSpan({ name: 'llm:plan', type: 'llm' });
    s.addTokens(100, 50, 0.001);
    s.end();
    await t.flush();
    // Span-level cost: get current record from store (append-only log)
    const spans = await m['opts'].store.spans.listByRun(t.id);
    const llm = spans.find((x) => x.name === 'llm:plan');
    assert.strictEqual(llm?.tokensIn, 100);
    assert.strictEqual(llm?.tokensOut, 50);
    await t.finish();
  });
});

test('addUsage: increments Run-level totals', async () => {
  await withManager(async (m) => {
    const t = await m.startRun({ task: 'x', model: baseModel, sessionId: 's' });
    await t.addUsage(1000, 500);
    await t.addUsage(200, 100);
    const r = (await m['opts'].store.runs.list())[0];
    assert.strictEqual(r.totalTokensIn, 1200);
    assert.strictEqual(r.totalTokensOut, 600);
    // cost = 1200/1000*0.0025 + 600/1000*0.01 = 0.003 + 0.006 = 0.009
    assert.strictEqual(r.totalCostUsd, 0.009);
    await t.finish();
  });
});

test('Span: fail sets status=error and error ref', async () => {
  await withManager(async (m) => {
    const t = await m.startRun({ task: 'x', model: baseModel, sessionId: 's' });
    const s = t.startSpan({ name: 'tool:edit', type: 'tool' });
    s.fail({ code: '2002', message: 'denied' });
    s.end();
    await t.flush();
    const got = (await m['opts'].store.spans.listByRun(t.id))[0];
    assert.strictEqual(got.status, 'error');
    assert.strictEqual(got.error?.code, '2002');
    await t.finish();
  });
});

test('nested spans: parentSpanId links children', async () => {
  await withManager(async (m) => {
    const t = await m.startRun({ task: 'x', model: baseModel, sessionId: 's' });
    const parent = t.startSpan({ name: 'planner', type: 'planner' });
    const child = t.startSpan({ name: 'llm:plan', type: 'llm', parentSpanId: parent.id });
    child.end();
    parent.end();
    await t.flush();
    const spans = await m['opts'].store.spans.listByRun(t.id);
    const c = spans.find((x) => x.id === child.id);
    assert.strictEqual(c?.parentSpanId, parent.id);
    await t.finish();
  });
});

test('appendEvent: writes JSONL line to traces/<runId>.jsonl', async () => {
  await withManager(async (m, _store, root) => {
    const t = await m.startRun({ task: 'x', model: baseModel, sessionId: 's' });
    t.appendEvent({ ts: 1, name: 'first' });
    t.appendEvent({ ts: 2, name: 'second', attributes: { k: 'v' } });
    const file = join(root, 'traces', `${t.id}.jsonl`);
    assert.ok(existsSync(file));
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    assert.strictEqual(lines.length, 2);
    const e1 = JSON.parse(lines[0]);
    const e2 = JSON.parse(lines[1]);
    assert.strictEqual(e1.name, 'first');
    assert.strictEqual(e2.attributes.k, 'v');
    await t.finish();
  });
});

test('only one active run at a time', async () => {
  await withManager(async (m) => {
    const t = await m.startRun({ task: 'x', model: baseModel, sessionId: 's' });
    await assert.rejects(() => m.startRun({ task: 'y', model: baseModel, sessionId: 's' }));
    await t.finish();
    // After finish, we can start again
    const t2 = await m.startRun({ task: 'z', model: baseModel, sessionId: 's' });
    await t2.finish();
  });
});

test('TraceManager.errorOf: classifies a thrown error', async () => {
  await withManager(async () => {
    const e = TraceManager.errorOf(new Error('context length exceeded'));
    assert.strictEqual(e.code, '1002');   // ContextOverflow
  });
});
