// Integration tests for FileStore.
// Uses a per-test temp directory; never touches real user data.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { createFileStore, type Store, type FileStoreOptions } from '../jsonl-store';
import type { AgentRun, AgentSpan, Evaluation, Benchmark, Baseline, PromptCandidate, SpanEvent } from '../../../contracts';

// ── Per-test temp dir helper ──────────────────────────────────────────

async function withStore<T>(
  fn: (store: Store, root: string) => Promise<T>,
  options: Partial<FileStoreOptions> = {}
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'z-store-'));
  try {
    const store = await createFileStore({ rootDir: root, ...options });
    return await fn(store, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// ── Fixtures ──────────────────────────────────────────────────────────

function mkRun(over: Partial<AgentRun> = {}): AgentRun {
  return {
    id: 'run-' + Math.random().toString(36).slice(2),
    traceId: 'trace-' + Math.random().toString(36).slice(2),
    sessionId: 'sess-1',
    task: 'do something',
    model: { provider: 'openai', name: 'gpt-4o' },
    startTime: 1000,
    status: 'running',
    totalTokensIn: 0,
    totalTokensOut: 0,
    totalCostUsd: 0,
    tags: ['demo'],
    metadata: {},
    ...over,
  };
}

function mkSpan(runId: string, over: Partial<AgentSpan> = {}): AgentSpan {
  return {
    id: 'span-' + Math.random().toString(36).slice(2),
    traceId: 'trace-x',
    runId,
    name: 'tool:edit_file',
    type: 'tool',
    startTime: 1000,
    status: 'ok',
    attributes: {},
    events: [],
    ...over,
  };
}

function mkEval(runId: string, total: number, pass: boolean): Evaluation {
  return {
    id: 'ev-' + Math.random().toString(36).slice(2),
    runId,
    benchmarkId: 'b1',
    scores: { test: total },
    total,
    pass,
    timestamp: 1000,
    durationMs: 100,
  };
}

function mkBench(id: string, over: Partial<Benchmark> = {}): Benchmark {
  return {
    id,
    name: id,
    prompt: 'p',
    repo: 'r',
    baseCommit: 'c',
    testCommands: ['npm test'],
    difficulty: 'medium',
    tags: ['t1'],
    rubric: { test: 1 },
    ...over,
  };
}

// ── RunRepo ───────────────────────────────────────────────────────────

test('runs: insert + get round-trip', async () => {
  await withStore(async (store) => {
    const r = mkRun({ id: 'r1', task: 'hello' });
    await store.runs.insert(r);
    const got = await store.runs.get('r1');
    assert.deepStrictEqual(got?.task, 'hello');
    assert.strictEqual(got?.status, 'running');
  });
});

test('runs: list filters by status', async () => {
  await withStore(async (store) => {
    await store.runs.insert(mkRun({ id: 'a', status: 'success' }));
    await store.runs.insert(mkRun({ id: 'b', status: 'failed' }));
    await store.runs.insert(mkRun({ id: 'c', status: 'success' }));
    const succ = await store.runs.list({ status: 'success' });
    assert.strictEqual(succ.length, 2);
    const ids = succ.map((r) => r.id).sort();
    assert.deepStrictEqual(ids, ['a', 'c']);
  });
});

test('runs: list filters by tagsAny', async () => {
  await withStore(async (store) => {
    await store.runs.insert(mkRun({ id: 'a', tags: ['x', 'y'] }));
    await store.runs.insert(mkRun({ id: 'b', tags: ['z'] }));
    const out = await store.runs.list({ tagsAny: ['x'] });
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].id, 'a');
  });
});

test('runs: list filters by fromTs/toTs', async () => {
  await withStore(async (store) => {
    await store.runs.insert(mkRun({ id: 'old', startTime: 100 }));
    await store.runs.insert(mkRun({ id: 'mid', startTime: 500 }));
    await store.runs.insert(mkRun({ id: 'new', startTime: 1000 }));
    const out = await store.runs.list({ fromTs: 200, toTs: 800 });
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].id, 'mid');
  });
});

test('runs: update merges fields', async () => {
  await withStore(async (store) => {
    const r = mkRun({ id: 'u1' });
    await store.runs.insert(r);
    await store.runs.update('u1', { status: 'success', endTime: 5000, totalTokensIn: 42 });
    const got = await store.runs.get('u1');
    assert.strictEqual(got?.status, 'success');
    assert.strictEqual(got?.endTime, 5000);
    assert.strictEqual(got?.totalTokensIn, 42);
    assert.strictEqual(got?.task, r.task);
  });
});

test('runs: update missing id throws', async () => {
  await withStore(async (store) => {
    await assert.rejects(() => store.runs.update('nope', { status: 'success' }));
  });
});

test('runs: delete hides from list and get', async () => {
  await withStore(async (store) => {
    await store.runs.insert(mkRun({ id: 'd1' }));
    await store.runs.delete('d1');
    assert.strictEqual(await store.runs.get('d1'), undefined);
    assert.strictEqual((await store.runs.list()).length, 0);
  });
});

test('runs: count respects filters', async () => {
  await withStore(async (store) => {
    await store.runs.insert(mkRun({ id: 'a', status: 'success' }));
    await store.runs.insert(mkRun({ id: 'b', status: 'failed' }));
    assert.strictEqual(await store.runs.count({ status: 'success' }), 1);
    assert.strictEqual(await store.runs.count(), 2);
  });
});

test('runs: list paginates', async () => {
  await withStore(async (store) => {
    for (let i = 0; i < 5; i++) {
      await store.runs.insert(mkRun({ id: `r${i}`, startTime: 1000 + i }));
    }
    const page1 = await store.runs.list({ limit: 2, offset: 0, order: 'asc' });
    const page2 = await store.runs.list({ limit: 2, offset: 2, order: 'asc' });
    assert.deepStrictEqual(page1.map((r) => r.id), ['r0', 'r1']);
    assert.deepStrictEqual(page2.map((r) => r.id), ['r2', 'r3']);
  });
});

// ── SpanRepo ──────────────────────────────────────────────────────────

test('spans: insert + listByRun filters by runId', async () => {
  await withStore(async (store) => {
    await store.spans.insert(mkSpan('run-A', { id: 's1' }));
    await store.spans.insert(mkSpan('run-A', { id: 's2', type: 'llm' }));
    await store.spans.insert(mkSpan('run-B', { id: 's3' }));
    const a = await store.spans.listByRun('run-A');
    assert.strictEqual(a.length, 2);
    const b = await store.spans.listByRun('run-B');
    assert.strictEqual(b.length, 1);
  });
});

test('spans: list filters by type and status', async () => {
  await withStore(async (store) => {
    await store.spans.insert(mkSpan('r', { id: 's1', type: 'tool', status: 'ok' }));
    await store.spans.insert(mkSpan('r', { id: 's2', type: 'llm', status: 'error' }));
    await store.spans.insert(mkSpan('r', { id: 's3', type: 'tool', status: 'error' }));
    const tools = await store.spans.list({ type: 'tool' });
    assert.strictEqual(tools.length, 2);
    const errors = await store.spans.list({ status: 'error' });
    assert.strictEqual(errors.length, 2);
  });
});

test('spans: deleteByRun returns count and removes only that run', async () => {
  await withStore(async (store) => {
    await store.spans.insert(mkSpan('A', { id: 's1' }));
    await store.spans.insert(mkSpan('A', { id: 's2' }));
    await store.spans.insert(mkSpan('B', { id: 's3' }));
    const n = await store.spans.deleteByRun('A');
    assert.strictEqual(n, 2);
    assert.strictEqual((await store.spans.listByRun('A')).length, 0);
    assert.strictEqual((await store.spans.listByRun('B')).length, 1);
  });
});

test('spans: update adds an event', async () => {
  await withStore(async (store) => {
    const s = mkSpan('r', { id: 'su', events: [{ ts: 1, name: 'start' }] });
    await store.spans.insert(s);
    await store.spans.update('su', { events: [...s.events, { ts: 2, name: 'end' }] });
    const got = await store.spans.get('su');
    assert.strictEqual(got?.events.length, 2);
  });
});

// ── EvalRepo ──────────────────────────────────────────────────────────

test('evals: passRate over mixed', async () => {
  await withStore(async (store) => {
    await store.evals.insert(mkEval('r1', 80, true));
    await store.evals.insert(mkEval('r1', 40, false));
    await store.evals.insert(mkEval('r2', 90, true));
    const rate = await store.evals.passRate();
    assert.strictEqual(rate, 2 / 3);
  });
});

test('evals: passRate empty => 0', async () => {
  await withStore(async (store) => {
    assert.strictEqual(await store.evals.passRate(), 0);
  });
});

test('evals: list filters by pass', async () => {
  await withStore(async (store) => {
    await store.evals.insert(mkEval('r', 80, true));
    await store.evals.insert(mkEval('r', 40, false));
    assert.strictEqual((await store.evals.list({ pass: true })).length, 1);
    assert.strictEqual((await store.evals.list({ pass: false })).length, 1);
  });
});

// ── BenchmarkRepo ─────────────────────────────────────────────────────

test('benchmarks: insert + get + list', async () => {
  await withStore(async (store) => {
    await store.benchmarks.insert(mkBench('b1', { difficulty: 'easy' }));
    await store.benchmarks.insert(mkBench('b2', { difficulty: 'hard' }));
    const got = await store.benchmarks.get('b1');
    assert.strictEqual(got?.difficulty, 'easy');
    const easy = await store.benchmarks.list({ difficulty: 'easy' });
    assert.strictEqual(easy.length, 1);
  });
});

test('benchmarks: insert duplicate throws', async () => {
  await withStore(async (store) => {
    await store.benchmarks.insert(mkBench('dup'));
    await assert.rejects(() => store.benchmarks.insert(mkBench('dup')));
  });
});

test('benchmarks: upsert replaces existing', async () => {
  await withStore(async (store) => {
    await store.benchmarks.insert(mkBench('up', { difficulty: 'easy' }));
    await store.benchmarks.upsert(mkBench('up', { difficulty: 'hard' }));
    assert.strictEqual((await store.benchmarks.get('up'))?.difficulty, 'hard');
    assert.strictEqual(await store.benchmarks.count(), 1);
  });
});

test('benchmarks: delete removes', async () => {
  await withStore(async (store) => {
    await store.benchmarks.insert(mkBench('x'));
    await store.benchmarks.delete('x');
    assert.strictEqual(await store.benchmarks.get('x'), undefined);
  });
});

// ── traceStream ───────────────────────────────────────────────────────

test('traceStream: missing run => empty async iterable', async () => {
  await withStore(async (store) => {
    const events: SpanEvent[] = [];
    for await (const ev of store.traceStream('no-such-run')) {
      events.push(ev);
    }
    assert.strictEqual(events.length, 0);
  });
});

test('traceStream: yields events in ts order from traces/<runId>.jsonl', async () => {
  await withStore(async (store, root) => {
    const { appendFile } = await import('fs/promises');
    const runId = 'tr-1';
    const events: SpanEvent[] = [
      { ts: 1, name: 'start' },
      { ts: 2, name: 'middle', attributes: { k: 'v' } },
      { ts: 3, name: 'end' },
    ];
    for (const ev of events) {
      await appendFile(join(root, 'traces', `${runId}.jsonl`), JSON.stringify(ev) + '\n');
    }
    const out: SpanEvent[] = [];
    for await (const ev of store.traceStream(runId)) {
      out.push(ev);
    }
    assert.strictEqual(out.length, 3);
    assert.deepStrictEqual(out.map((e) => e.ts), [1, 2, 3]);
  });
});

// ── Cross-cutting: persistence across reopens ────────────────────────

test('reopen: data survives a new FileStore on the same root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'z-store-persist-'));
  try {
    let s = await createFileStore({ rootDir: root });
    await s.runs.insert(mkRun({ id: 'p1', task: 'persistent' }));
    await s.benchmarks.insert(mkBench('pb'));
    await s.close();

    s = await createFileStore({ rootDir: root });
    assert.strictEqual((await s.runs.get('p1'))?.task, 'persistent');
    assert.ok(await s.benchmarks.get('pb'));
    await s.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ── BaselineRepo ──────────────────────────────────────────────────────

function mkBaseline(over: Partial<Baseline> = {}): Baseline {
  return {
    id: 'bl-1',
    name: 'v0.3',
    benchmarkId: 'b1',
    evaluations: [],
    createdAt: 1000,
    ...over,
  };
}

test('baselines: insert + get + list', async () => {
  await withStore(async (store) => {
    await store.baselines.insert(mkBaseline({ id: 'b:v1' }));
    await store.baselines.insert(mkBaseline({ id: 'b:v2', name: 'v2', createdAt: 2000 }));
    const got = await store.baselines.get('b:v1');
    assert.strictEqual(got?.name, 'v1');
    const all = await store.baselines.list();
    assert.strictEqual(all.length, 2);
    // sorted by createdAt desc
    assert.strictEqual(all[0].id, 'b:v2');
  });
});

test('baselines: insert duplicate throws', async () => {
  await withStore(async (store) => {
    await store.baselines.insert(mkBaseline({ id: 'b:dup' }));
    await assert.rejects(() => store.baselines.insert(mkBaseline({ id: 'b:dup' })));
  });
});

test('baselines: upsert replaces existing', async () => {
  await withStore(async (store) => {
    await store.baselines.insert(mkBaseline({ id: 'b:u', name: 'old' }));
    await store.baselines.upsert(mkBaseline({ id: 'b:u', name: 'new' }));
    assert.strictEqual((await store.baselines.get('b:u'))?.name, 'new');
    assert.strictEqual(await store.baselines.count(), 1);
  });
});

test('baselines: list filters by benchmarkId', async () => {
  await withStore(async (store) => {
    await store.baselines.insert(mkBaseline({ id: 'b1:v1', benchmarkId: 'b1' }));
    await store.baselines.insert(mkBaseline({ id: 'b2:v1', benchmarkId: 'b2' }));
    const b1 = await store.baselines.list({ benchmarkId: 'b1' });
    assert.strictEqual(b1.length, 1);
    assert.strictEqual(b1[0].id, 'b1:v1');
  });
});

test('baselines: delete removes', async () => {
  await withStore(async (store) => {
    await store.baselines.insert(mkBaseline({ id: 'b:x' }));
    await store.baselines.delete('b:x');
    assert.strictEqual(await store.baselines.get('b:x'), undefined);
  });
});

test('baselines: snapshot stores evaluations at create time', async () => {
  await withStore(async (store) => {
    await store.evals.insert(mkEval('r1', 80, true));
    await store.evals.insert(mkEval('r1', 40, false));
    // Manually snapshot: file store stores what we pass in.
    const evals = await store.evals.list({ benchmarkId: 'b1' });
    await store.baselines.insert({
      id: 'b1:snap',
      name: 'snap',
      benchmarkId: 'b1',
      evaluations: evals,
      createdAt: Date.now(),
    });
    const got = await store.baselines.get('b1:snap');
    assert.strictEqual(got?.evaluations.length, 2);
  });
});

// ── PromptCandidateRepo ──────────────────────────────────────────────

function mkCandidate(over: Partial<PromptCandidate> = {}): PromptCandidate {
  return {
    id: 'c1',
    agentName: 'planner',
    name: 'planner-default',
    variants: [
      { id: 'v-control', label: 'control', content: 'You are a planner.', createdAt: 1000 },
    ],
    activeVariantId: 'v-control',
    createdAt: 1000,
    updatedAt: 1000,
    ...over,
  };
}

test('candidates: upsert + get + list', async () => {
  await withStore(async (store) => {
    await store.candidates.upsert(mkCandidate({ id: 'c1' }));
    await store.candidates.upsert(mkCandidate({ id: 'c2', name: 'planner-experimental', updatedAt: 2000 }));
    const got = await store.candidates.get('c1');
    assert.strictEqual(got?.agentName, 'planner');
    const all = await store.candidates.list();
    assert.strictEqual(all.length, 2);
    // Sorted by updatedAt desc
    assert.strictEqual(all[0].id, 'c2');
  });
});

test('candidates: list filters by agentName', async () => {
  await withStore(async (store) => {
    await store.candidates.upsert(mkCandidate({ id: 'a', agentName: 'planner' }));
    await store.candidates.upsert(mkCandidate({ id: 'b', agentName: 'coder' }));
    const out = await store.candidates.list({ agentName: 'planner' });
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].id, 'a');
  });
});

test('candidates: delete removes', async () => {
  await withStore(async (store) => {
    await store.candidates.upsert(mkCandidate({ id: 'x' }));
    await store.candidates.delete('x');
    assert.strictEqual(await store.candidates.get('x'), undefined);
  });
});

test('candidates: upsert replaces existing', async () => {
  await withStore(async (store) => {
    await store.candidates.upsert(mkCandidate({ id: 'u', name: 'old' }));
    await store.candidates.upsert(mkCandidate({ id: 'u', name: 'new' }));
    assert.strictEqual((await store.candidates.get('u'))?.name, 'new');
    assert.strictEqual(await store.candidates.count(), 1);
  });
});
