// End-to-end integration test for V2 Instrumenter: verify that wrapped
// LLM + Tool produce queryable Spans in the Store, matching what any
// downstream UI (Dashboard, Trace panel) will read.
//
// This is the Phase 1 acceptance test for the V2 trace package.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { TraceManager, Instrumenter } from '../index';
import { createFileStore, type Store } from '@ziner/infra-storage';
import type { InstrumentableLLM, InstrumentableTool } from '../instrumentation';

// ── Mocks (duck-typed, no V1 dependencies) ────────────────────────────

class MockLLM implements InstrumentableLLM {
  async generate(_req: { messages: Array<{ role: string; content: string }>; stream?: boolean }): Promise<string> {
    return 'This is a mock LLM response.';
  }
  async *generateStream(_req: { messages: Array<{ role: string; content: string }>; stream?: boolean }): AsyncIterable<string> {
    yield 'This ';
    yield 'is ';
    yield 'a ';
    yield 'mock ';
    yield 'stream.';
  }
  // Satisfy the duck-typed index signature.
  [k: string]: unknown;
}

class MockToolRegistry implements InstrumentableTool {
  async execute(name: string, _params: Record<string, unknown>): Promise<string> {
    if (name === 'fail_tool') throw new Error('tool failed on purpose');
    return JSON.stringify({ ok: true, tool: name });
  }
  [k: string]: unknown;
}

// ── Test ──────────────────────────────────────────────────────────────

async function withManager<T>(fn: (m: TraceManager, store: Store) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'z-trace-e2e-'));
  try {
    const store = await createFileStore({ rootDir: root });
    const m = new TraceManager({ store, tracesDir: join(root, 'traces') });
    return await fn(m, store);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const model = { provider: 'sglang', name: 'default' };  // matches DEFAULT_PRICING

test('e2e: wrapped LLM.generate produces an llm Span queryable from Store', async () => {
  await withManager(async (m, store) => {
    const t = await m.startRun({ task: 'test e2e', model, sessionId: 's1' });
    const inst = new Instrumenter({ tracker: t });
    const llm = inst.wrapLLM(new MockLLM(), model);

    const out = await llm.generate({ messages: [{ role: 'user', content: 'hello' }] });
    assert.strictEqual(out, 'This is a mock LLM response.');

    await t.flush();
    await t.finish();

    const spans = await store.spans.listByRun(t.id);
    const llmSpan = spans.find((s) => s.type === 'llm');
    assert.ok(llmSpan, 'expected an llm Span');
    assert.strictEqual(llmSpan!.status, 'ok');
    assert.ok(llmSpan!.tokensIn! > 0);
    assert.ok(llmSpan!.tokensOut! > 0);
    assert.ok(llmSpan!.costUsd !== undefined);

    const run = (await store.runs.list())[0];
    assert.strictEqual(run.totalTokensIn, llmSpan!.tokensIn);
    assert.strictEqual(run.totalTokensOut, llmSpan!.tokensOut);
    assert.strictEqual(run.status, 'success');
  });
});

test('e2e: wrapped LLM.generateStream produces an llm Span with stream events', async () => {
  await withManager(async (m, store) => {
    const t = await m.startRun({ task: 'stream test', model, sessionId: 's1' });
    const inst = new Instrumenter({ tracker: t });
    const llm = inst.wrapLLM(new MockLLM(), model);

    let acc = '';
    for await (const chunk of llm.generateStream!({ messages: [{ role: 'user', content: 'hi' }] })) {
      acc += chunk;
    }
    assert.strictEqual(acc, 'This is a mock stream.');

    await t.flush();
    await t.finish();

    const spans = await store.spans.listByRun(t.id);
    const llmSpan = spans.find((s) => s.type === 'llm');
    assert.ok(llmSpan);
    const chunkEvents = llmSpan!.events.filter((e) => e.name === 'stream.chunk');
    assert.strictEqual(chunkEvents.length, 5);  // 5 yields
  });
});

test('e2e: wrapped Tool.execute produces a tool Span', async () => {
  await withManager(async (m, store) => {
    const t = await m.startRun({ task: 'tool test', model, sessionId: 's1' });
    const inst = new Instrumenter({ tracker: t });
    const tools = inst.wrapToolRegistry(new MockToolRegistry());

    const out = await tools.execute('edit_file', { path: 'a.ts' });
    assert.ok(JSON.parse(out).ok);

    await t.flush();
    await t.finish();

    const spans = await store.spans.listByRun(t.id);
    const toolSpan = spans.find((s) => s.type === 'tool');
    assert.ok(toolSpan);
    assert.strictEqual(toolSpan!.name, 'tool:edit_file');
    assert.strictEqual(toolSpan!.status, 'ok');
    assert.ok(toolSpan!.attributes['tool.duration_ms'] !== undefined);
  });
});

test('e2e: failed tool call produces an error Span', async () => {
  await withManager(async (m, store) => {
    const t = await m.startRun({ task: 'fail test', model, sessionId: 's1' });
    const inst = new Instrumenter({ tracker: t });
    const tools = inst.wrapToolRegistry(new MockToolRegistry());

    await assert.rejects(() => tools.execute('fail_tool', {}));
    await t.flush();
    await t.finish();

    const spans = await store.spans.listByRun(t.id);
    const toolSpan = spans.find((s) => s.type === 'tool');
    assert.ok(toolSpan);
    assert.strictEqual(toolSpan!.status, 'error');
    assert.ok(toolSpan!.error);
    assert.ok(toolSpan!.error!.code.length > 0);
  });
});

test('e2e: multiple LLM + Tool calls aggregate into one Run', async () => {
  await withManager(async (m, store) => {
    const t = await m.startRun({ task: 'multi-call', model, sessionId: 's1' });
    const inst = new Instrumenter({ tracker: t });
    const llm = inst.wrapLLM(new MockLLM(), model);
    const tools = inst.wrapToolRegistry(new MockToolRegistry());

    // Simulate a mini agent loop: LLM → Tool → LLM → Tool
    await llm.generate({ messages: [{ role: 'user', content: 'step 1' }] });
    await tools.execute('read_file', { path: 'a.ts' });
    await llm.generate({ messages: [{ role: 'user', content: 'step 2' }] });
    await tools.execute('edit_file', { path: 'a.ts' });

    await t.flush();
    await t.finish();

    const spans = await store.spans.listByRun(t.id);
    assert.strictEqual(spans.length, 4);
    const llmSpans = spans.filter((s) => s.type === 'llm');
    const toolSpans = spans.filter((s) => s.type === 'tool');
    assert.strictEqual(llmSpans.length, 2);
    assert.strictEqual(toolSpans.length, 2);

    const run = (await store.runs.list())[0];
    assert.ok(run.totalTokensIn > 0);
    assert.ok(run.totalTokensOut > 0);
    assert.strictEqual(run.status, 'success');
  });
});

test('e2e: trace events are readable via store.traceStream()', async () => {
  await withManager(async (m, store) => {
    const t = await m.startRun({ task: 'stream read', model, sessionId: 's1' });
    t.appendEvent({ ts: 1, name: 'run.start' });
    const inst = new Instrumenter({ tracker: t });
    const tools = inst.wrapToolRegistry(new MockToolRegistry());
    await tools.execute('edit_file', {});
    t.appendEvent({ ts: 2, name: 'run.end' });
    await t.flush();
    await t.finish();

    const events: { ts: number; name: string }[] = [];
    for await (const ev of store.traceStream(t.id)) {
      events.push(ev);
    }
    assert.ok(events.length >= 2);
    assert.strictEqual(events[0].name, 'run.start');
    assert.strictEqual(events[events.length - 1].name, 'run.end');
  });
});
