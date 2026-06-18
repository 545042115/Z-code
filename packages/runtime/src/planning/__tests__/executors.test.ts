// Tests for the V2 Plan executors.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import type { Plan, PlanStep, TaskContext } from '@z-assistant/contracts';
import { executeSequential } from '../sequential-executor';
import { executeDag, buildWaves } from '../dag-executor';

function makeCtx(): TaskContext {
  return {
    task: 't',
    model: { provider: 'p', name: 'n' },
    sessionId: 's',
    parentRunId: 'r',
    traceId: 'tr',
    sharedState: { get: () => undefined, set: () => undefined, has: () => false, delete: () => false, incr: () => 0, size: () => 0, snapshot: () => ({}), subscribe: () => () => undefined, subscribeAny: () => () => undefined } as TaskContext['sharedState'],
    budget: { tokensLeft: 1000, costLeftUsd: 1 },
  };
}

function mkPlan(...ids: string[]): Plan {
  return {
    id: 'p1',
    name: 'test',
    steps: ids.map((id) => ({ id, name: id, status: 'pending' })),
  };
}

test('executeSequential: runs all steps in order', async () => {
  const plan = mkPlan('a', 'b', 'c');
  const order: string[] = [];
  const r = await executeSequential(plan, makeCtx(), async (step) => {
    order.push(step.id);
    return step.id;
  });
  assert.deepStrictEqual(order, ['a', 'b', 'c']);
  assert.strictEqual(r.ok, true);
  for (const s of r.steps) {
    assert.strictEqual(s.status, 'ok');
    assert.ok(s.durationMs! >= 0);
  }
});

test('executeSequential: stops on first error', async () => {
  const plan = mkPlan('a', 'b', 'c');
  const r = await executeSequential(plan, makeCtx(), async (step) => {
    if (step.id === 'b') throw new Error('boom');
    return step.id;
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(plan.steps[0].status, 'ok');
  assert.strictEqual(plan.steps[1].status, 'error');
  assert.strictEqual(plan.steps[2].status, 'skipped');
  assert.strictEqual(r.error?.message, 'boom');
});

test('executeSequential: continues past error when stopOnError=false', async () => {
  const plan = mkPlan('a', 'b', 'c');
  const r = await executeSequential(plan, makeCtx(), async (step) => {
    if (step.id === 'b') throw new Error('boom');
    return step.id;
  }, { stopOnError: false });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(plan.steps[2].status, 'ok');
});

test('buildWaves: respects dependsOn edges', () => {
  const plan: Plan = {
    id: 'p1', name: 'dag',
    steps: [
      { id: 'a', name: 'a', status: 'pending' },
      { id: 'b', name: 'b', status: 'pending', dependsOn: ['a'] },
      { id: 'c', name: 'c', status: 'pending', dependsOn: ['a'] },
      { id: 'd', name: 'd', status: 'pending', dependsOn: ['b', 'c'] },
    ],
  };
  const waves = buildWaves(plan);
  assert.deepStrictEqual(waves, [['a'], ['b', 'c'], ['d']]);
});

test('buildWaves: independent steps all land in wave 0', () => {
  const waves = buildWaves(mkPlan('a', 'b', 'c'));
  assert.deepStrictEqual(waves, [['a', 'b', 'c']]);
});

test('buildWaves: detects cycle (returns empty)', () => {
  const plan: Plan = {
    id: 'p', name: 'cyc',
    steps: [
      { id: 'a', name: 'a', status: 'pending', dependsOn: ['b'] },
      { id: 'b', name: 'b', status: 'pending', dependsOn: ['a'] },
    ],
  };
  assert.deepStrictEqual(buildWaves(plan), []);
});

test('executeDag: parallel steps in same wave run concurrently', async () => {
  const plan: Plan = {
    id: 'p', name: 't',
    steps: [
      { id: 'a', name: 'a', status: 'pending' },
      { id: 'b', name: 'b', status: 'pending' },
    ],
  };
  const order: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const r = await executeDag(plan, makeCtx(), async (step) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    order.push(`start:${step.id}`);
    await new Promise((r) => setTimeout(r, 20));
    order.push(`end:${step.id}`);
    inFlight--;
    return step.id;
  });
  assert.strictEqual(r.ok, true);
  // a and b should start before either ends
  const aStart = order.indexOf('start:a');
  const bStart = order.indexOf('start:b');
  const aEnd = order.indexOf('end:a');
  const bEnd = order.indexOf('end:b');
  assert.ok(Math.min(aEnd, bEnd) > Math.max(aStart, bStart));
  assert.ok(maxInFlight >= 1);
});

test('executeDag: cycle in Plan returns 4001', async () => {
  const plan: Plan = {
    id: 'p', name: 'cyc',
    steps: [
      { id: 'a', name: 'a', status: 'pending', dependsOn: ['b'] },
      { id: 'b', name: 'b', status: 'pending', dependsOn: ['a'] },
    ],
  };
  const r = await executeDag(plan, makeCtx(), async (s) => s.id);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error?.code, '4001');
});

test('executeDag: maxWaveSize caps concurrency', async () => {
  const plan: Plan = {
    id: 'p', name: 'cap',
    steps: [
      { id: 'a', name: 'a', status: 'pending' },
      { id: 'b', name: 'b', status: 'pending' },
      { id: 'c', name: 'c', status: 'pending' },
    ],
  };
  let inFlight = 0;
  let maxInFlight = 0;
  await executeDag(plan, makeCtx(), async (step) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    return step.id;
  }, { maxWaveSize: 2 });
  assert.ok(maxInFlight <= 2);
});
