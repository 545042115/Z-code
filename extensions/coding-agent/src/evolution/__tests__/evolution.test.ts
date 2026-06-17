// Unit tests for Evolution engine.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  normalizePattern,
  clusterFingerprints,
  suggestForCluster,
  fingerprintRun,
  type FailureFingerprint,
} from '../evolution';
import type { AgentRun, AgentSpan } from '../../contracts';

function mkRun(over: Partial<AgentRun> = {}): AgentRun {
  return {
    id: 'r1', traceId: 't1', sessionId: 's1', task: 't', status: 'failed',
    model: { provider: 'p', name: 'n' },
    startTime: 1000, endTime: 2000, duration: 1000,
    totalTokensIn: 0, totalTokensOut: 0, totalCostUsd: 0,
    tags: [], metadata: {},
    ...over,
  };
}

function mkSpan(over: Partial<AgentSpan> = {}): AgentSpan {
  return {
    id: 'sp1', runId: 'r1', traceId: 't1',
    name: 'agent:coder', type: 'agent', status: 'error',
    startTime: 1000, endTime: 2000, duration: 1000,
    input: null, output: null, attributes: {}, events: [],
    error: { code: '3001', message: 'tool exploded' },
    ...over,
  };
}

test('normalizePattern: replaces numbers, hex, quotes, punctuation', () => {
  const p = normalizePattern("ENOENT: no such file '/tmp/abc123' at 0xdeadbeef");
  assert.ok(p.includes('<n>'), 'numbers replaced');
  assert.ok(p.includes('<hex>'), 'hex replaced');
  assert.ok(p.includes('<q>'), 'quotes replaced');
  assert.ok(!p.includes("'"), 'raw quotes gone');
});

test('normalizePattern: stable for same shape, different numbers', () => {
  const a = normalizePattern('error 1234 at /tmp/x');
  const b = normalizePattern('error 5678 at /tmp/y');
  assert.strictEqual(a, b);
});

test('clusterFingerprints: groups by agent+code+pattern', () => {
  const fps: FailureFingerprint[] = [
    { runId: 'r1', task: 'a', sessionId: 's1', agent: 'coder', spanId: 's1', errorCode: '3001', errorMessage: 'boom', errorPattern: 'boom', timestamp: 1 },
    { runId: 'r1', task: 'a', sessionId: 's1', agent: 'coder', spanId: 's2', errorCode: '3001', errorMessage: 'boom', errorPattern: 'boom', timestamp: 2 },
    { runId: 'r2', task: 'b', sessionId: 's1', agent: 'reviewer', spanId: 's3', errorCode: '3002', errorMessage: 'x', errorPattern: 'x', timestamp: 3 },
  ];
  const clusters = clusterFingerprints(fps);
  assert.strictEqual(clusters.length, 2);
  // Sorted by count desc
  assert.strictEqual(clusters[0].count, 2);
  assert.strictEqual(clusters[1].count, 1);
});

test('clusterFingerprints: distinct runs/tasks counted', () => {
  const fps: FailureFingerprint[] = [
    { runId: 'r1', task: 'a', sessionId: 's1', agent: 'coder', spanId: 's1', errorCode: '3001', errorMessage: 'x', errorPattern: 'x', timestamp: 1 },
    { runId: 'r1', task: 'a', sessionId: 's1', agent: 'coder', spanId: 's2', errorCode: '3001', errorMessage: 'x', errorPattern: 'x', timestamp: 2 },
    { runId: 'r2', task: 'b', sessionId: 's1', agent: 'coder', spanId: 's3', errorCode: '3001', errorMessage: 'x', errorPattern: 'x', timestamp: 3 },
  ];
  const c = clusterFingerprints(fps)[0];
  assert.strictEqual(c.distinctRuns, 2);
  assert.strictEqual(c.distinctTasks, 2);
});

test('fingerprintRun: extracts failed spans only', () => {
  const run = mkRun();
  const spans: AgentSpan[] = [
    mkSpan({ id: 'a', status: 'ok' }),
    mkSpan({ id: 'b', status: 'error', error: { code: '3001', message: 'x' } }),
    mkSpan({ id: 'c', status: 'error', error: undefined }),  // failed but no error
  ];
  const fps = fingerprintRun(run, spans);
  assert.strictEqual(fps.length, 1);
  assert.strictEqual(fps[0].spanId, 'b');
});

test('suggestForCluster: 3001/3002 → prompt suggestion', () => {
  const c = {
    id: 'c1', signature: 'x', label: 'coder: [3001]', count: 3, distinctRuns: 2, distinctTasks: 2,
    samples: [{
      runId: 'r1', task: 'a', sessionId: 's1', agent: 'coder', spanId: 's1',
      errorCode: '3001', errorMessage: 'x', errorPattern: 'x', timestamp: 1,
    }],
    firstSeen: 1, lastSeen: 1,
  };
  const out = suggestForCluster(c);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].kind, 'prompt');
  if (out[0].kind === 'prompt') {
    assert.strictEqual(out[0].agentName, 'coder');
  }
});

test('suggestForCluster: 2002 → tool suggestion', () => {
  const c = {
    id: 'c1', signature: 'x', label: 'coder: [2002]', count: 2, distinctRuns: 2, distinctTasks: 1,
    samples: [{
      runId: 'r1', task: 'a', sessionId: 's1', agent: 'coder', spanId: 's1',
      errorCode: '2002', errorMessage: 'denied', errorPattern: 'denied', timestamp: 1,
    }],
    firstSeen: 1, lastSeen: 1,
  };
  const out = suggestForCluster(c);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].kind, 'tool');
});

test('suggestForCluster: 3003 → config suggestion', () => {
  const c = {
    id: 'c1', signature: 'x', label: 'coder: [3003]', count: 2, distinctRuns: 1, distinctTasks: 1,
    samples: [{
      runId: 'r1', task: 'a', sessionId: 's1', agent: 'coder', spanId: 's1',
      errorCode: '3003', errorMessage: 'budget', errorPattern: 'budget', timestamp: 1,
    }],
    firstSeen: 1, lastSeen: 1,
  };
  const out = suggestForCluster(c);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].kind, 'config');
});

test('suggestForCluster: unknown code returns no suggestion', () => {
  const c = {
    id: 'c1', signature: 'x', label: 'a: [9999]', count: 2, distinctRuns: 1, distinctTasks: 1,
    samples: [{
      runId: 'r1', task: 'a', sessionId: 's1', agent: 'a', spanId: 's1',
      errorCode: '9999', errorMessage: 'x', errorPattern: 'x', timestamp: 1,
    }],
    firstSeen: 1, lastSeen: 1,
  };
  assert.deepStrictEqual(suggestForCluster(c), []);
});
