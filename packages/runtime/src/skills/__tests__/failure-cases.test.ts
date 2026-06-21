// @z-assistant/runtime — failure case store tests

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { tmpdir } from 'os';
import { join } from 'path';
import { rmSync, mkdirSync, existsSync, readFileSync } from 'fs';
import {
  JsonlFailureCaseStore,
  NoopFailureCaseStore,
  createJsonlFailureCaseStore,
  failureCaseFromRun,
} from '../index';
import type { AgentRun, AgentSpan, FailureCase } from '@z-assistant/contracts';

function makeTempDir(): string {
  const dir = join(tmpdir(), `z-failure-cases-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  if (existsSync(dir)) rmSync(dir, { recursive: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

function fc(overrides: Partial<FailureCase> = {}): FailureCase {
  return {
    id: overrides.id ?? `fc-${Math.random().toString(36).slice(2)}`,
    timestamp: overrides.timestamp ?? Date.now(),
    runId: overrides.runId ?? 'run-1',
    agent: overrides.agent ?? 'planner',
    task: overrides.task ?? 'do thing',
    errorCode: overrides.errorCode ?? '3001',
    errorMessage: overrides.errorMessage ?? 'something failed',
    errorPattern: overrides.errorPattern ?? 'something failed',
    toolName: overrides.toolName,
  };
}

describe('JsonlFailureCaseStore', () => {
  let dir: string;
  let store: JsonlFailureCaseStore;

  beforeEach(() => {
    dir = makeTempDir();
    store = createJsonlFailureCaseStore({ rootDir: dir });
  });

  afterEach(async () => {
    await store.flush();
    rmSync(dir, { recursive: true, force: true });
  });

  it('records and lists a failure case', async () => {
    const c = fc({ id: 'a', errorMessage: 'boom' });
    await store.record(c);
    await store.flush();
    const list = await store.list();
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].id, 'a');
    assert.strictEqual(list[0].errorMessage, 'boom');
  });

  it('persists across instances (JSONL file on disk)', async () => {
    await store.record(fc({ id: 'p1' }));
    await store.record(fc({ id: 'p2' }));
    await store.flush();
    const file = join(dir, 'failure-cases.jsonl');
    assert.ok(existsSync(file));
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    assert.strictEqual(lines.length, 2);

    const reloaded = createJsonlFailureCaseStore({ rootDir: dir });
    const list = await reloaded.list();
    assert.strictEqual(list.length, 2);
    assert.ok(list.some((c) => c.id === 'p1'));
    assert.ok(list.some((c) => c.id === 'p2'));
  });

  it('filters by agent, errorCode, errorPattern, and toolName', async () => {
    await store.record(fc({ id: 'a1', agent: 'planner', errorCode: '3001', errorPattern: 'p1', toolName: 'edit' }));
    await store.record(fc({ id: 'a2', agent: 'planner', errorCode: '3002', errorPattern: 'p2', toolName: 'run' }));
    await store.record(fc({ id: 'a3', agent: 'coder', errorCode: '3001', errorPattern: 'p1', toolName: 'edit' }));
    await store.flush();

    const byAgent = await store.list({ agent: 'planner' });
    assert.strictEqual(byAgent.length, 2);

    const byCode = await store.list({ errorCode: '3001' });
    assert.strictEqual(byCode.length, 2);

    const byPattern = await store.list({ errorPattern: 'p2' });
    assert.strictEqual(byPattern.length, 1);
    assert.strictEqual(byPattern[0].id, 'a2');

    const byTool = await store.list({ toolName: 'edit' });
    assert.strictEqual(byTool.length, 2);
  });

  it('filters by time range', async () => {
    await store.record(fc({ id: 't1', timestamp: 1000 }));
    await store.record(fc({ id: 't2', timestamp: 2000 }));
    await store.record(fc({ id: 't3', timestamp: 3000 }));
    await store.flush();

    const mid = await store.list({ fromTs: 1500, toTs: 2500 });
    assert.strictEqual(mid.length, 1);
    assert.strictEqual(mid[0].id, 't2');

    const tail = await store.list({ fromTs: 2000 });
    assert.strictEqual(tail.length, 2);
  });

  it('count matches list length', async () => {
    await store.record(fc({ id: 'c1', agent: 'a' }));
    await store.record(fc({ id: 'c2', agent: 'b' }));
    await store.record(fc({ id: 'c3', agent: 'a' }));
    await store.flush();
    const n = await store.count({ agent: 'a' });
    const list = await store.list({ agent: 'a' });
    assert.strictEqual(n, list.length);
    assert.strictEqual(n, 2);
  });

  it('groups by (agent, errorCode, errorPattern)', async () => {
    await store.record(fc({ id: 'g1', agent: 'planner', errorCode: '3001', errorPattern: 'p1', timestamp: 1000, toolName: 'edit' }));
    await store.record(fc({ id: 'g2', agent: 'planner', errorCode: '3001', errorPattern: 'p1', timestamp: 2000, toolName: 'edit' }));
    await store.record(fc({ id: 'g3', agent: 'planner', errorCode: '3001', errorPattern: 'p1', timestamp: 3000, toolName: 'run' }));
    await store.record(fc({ id: 'g4', agent: 'coder', errorCode: '3002', errorPattern: 'p2', timestamp: 1500 }));
    await store.flush();
    const groups = await store.group();
    assert.strictEqual(groups.length, 2);
    const planner = groups.find((g) => g.agent === 'planner')!;
    assert.ok(planner);
    assert.strictEqual(planner.cases.length, 3);
    assert.strictEqual(planner.firstSeen, 1000);
    assert.strictEqual(planner.lastSeen, 3000);
    assert.deepStrictEqual([...planner.toolNames].sort(), ['edit', 'run']);
  });

  it('failureCaseFromRun produces correct fields', () => {
    const run: AgentRun = {
      id: 'r1',
      traceId: 't',
      sessionId: 's',
      task: 'compile project'.padEnd(220, '.'),
      model: { provider: 'x', name: 'm' },
      startTime: 0,
      status: 'failed',
      totalTokensIn: 0,
      totalTokensOut: 0,
      totalCostUsd: 0,
      tags: [],
      metadata: {},
    };
    const spans: AgentSpan[] = [
      {
        id: 's1',
        traceId: 't',
        runId: 'r1',
        name: 'planner',
        type: 'planner',
        startTime: 1234,
        status: 'error',
        attributes: {},
        events: [],
        error: { code: '3001', message: 'Failed at /tmp/foo.ts line 12' },
      },
      {
        id: 's2',
        traceId: 't',
        runId: 'r1',
        name: 'tool:edit_file',
        type: 'tool',
        startTime: 1500,
        status: 'ok',
        attributes: { 'tool.name': 'edit_file' },
        events: [],
      },
    ];
    const cases = failureCaseFromRun(run, spans);
    assert.strictEqual(cases.length, 1);
    assert.strictEqual(cases[0].agent, 'planner');
    assert.strictEqual(cases[0].errorCode, '3001');
    assert.strictEqual(cases[0].runId, 'r1');
    assert.strictEqual(cases[0].timestamp, 1234);
    assert.ok(cases[0].errorPattern.length > 0);
    assert.ok(cases[0].task.length <= 200);
  });

  it('respects the limit option', async () => {
    for (let i = 0; i < 5; i++) {
      await store.record(fc({ id: `l${i}`, timestamp: 1000 + i }));
    }
    await store.flush();
    const top = await store.list({ limit: 2 });
    assert.strictEqual(top.length, 2);
    // newest-first
    assert.strictEqual(top[0].id, 'l4');
    assert.strictEqual(top[1].id, 'l3');
  });

  it('NoopFailureCaseStore returns empty arrays', async () => {
    const noop = new NoopFailureCaseStore();
    await noop.record(fc());
    assert.deepStrictEqual(await noop.list(), []);
    assert.strictEqual(await noop.count(), 0);
    assert.deepStrictEqual(await noop.group(), []);
  });
});
