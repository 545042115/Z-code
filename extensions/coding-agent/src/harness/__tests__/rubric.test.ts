// Tests for Rubric scoring.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  scoreSandboxResult,
  exitCodeZero,
  noTimeout,
  noStderr,
  stdoutMatches,
  minArtifacts,
  hasArtifact,
  durationUnderMs,
  allOf,
  type RubricSpec,
} from '../rubric';
import type { SandboxResult } from '../sandbox';

function mkResult(over: Partial<SandboxResult> = {}): SandboxResult {
  return {
    exitCode: 0, stdout: 'OK', stderr: '', durationMs: 100, timedOut: false,
    artifacts: ['result.json'], ...over,
  };
}

const passAll: RubricSpec = {
  id: 'r', name: 'R', passThreshold: 1,
  weights: { a: 1 },
  checks: { a: () => 1 },
};

test('score: empty rubric returns 0', async () => {
  const r = mkResult();
  const out = await scoreSandboxResult(r, { id: 'r', name: 'R', passThreshold: 1, weights: {}, checks: {} });
  assert.strictEqual(out.total, 0);
  assert.strictEqual(out.passed, false);
});

test('score: weighted average normalized to 0-100', async () => {
  const r = mkResult();
  const rubric: RubricSpec = {
    id: 'r', name: 'R', passThreshold: 50,
    weights: { a: 0.5, b: 0.5 },
    checks: { a: () => 1, b: () => 0 },
  };
  const out = await scoreSandboxResult(r, rubric);
  assert.strictEqual(out.total, 50);
  assert.strictEqual(out.passed, true);
  assert.deepStrictEqual(out.scores, { a: 1, b: 0 });
});

test('score: built-in exitCodeZero', async () => {
  const r = mkResult();
  const out = await scoreSandboxResult(r, {
    id: 'r', name: 'R', passThreshold: 1, weights: { a: 1 }, checks: { a: exitCodeZero },
  });
  assert.strictEqual(out.total, 100);
});

test('score: built-in noTimeout', async () => {
  const r = mkResult({ timedOut: true });
  const out = await scoreSandboxResult(r, {
    id: 'r', name: 'R', passThreshold: 1, weights: { a: 1 }, checks: { a: noTimeout },
  });
  assert.strictEqual(out.total, 0);
});

test('score: built-in noStderr', async () => {
  const r = mkResult({ stderr: 'warning' });
  const out = await scoreSandboxResult(r, {
    id: 'r', name: 'R', passThreshold: 1, weights: { a: 1 }, checks: { a: noStderr },
  });
  assert.strictEqual(out.total, 0);
});

test('score: built-in stdoutMatches', async () => {
  const r = mkResult({ stdout: 'tests: 5 passed' });
  const out = await scoreSandboxResult(r, {
    id: 'r', name: 'R', passThreshold: 1, weights: { a: 1 }, checks: { a: stdoutMatches(/passed/) },
  });
  assert.strictEqual(out.total, 100);
});

test('score: built-in minArtifacts partial credit', async () => {
  const r = mkResult({ artifacts: ['a', 'b'] });
  const out = await scoreSandboxResult(r, {
    id: 'r', name: 'R', passThreshold: 1, weights: { a: 1 }, checks: { a: minArtifacts(4) },
  });
  assert.strictEqual(out.total, 50);   // 2/4 → 0.5 → 50
});

test('score: built-in hasArtifact', async () => {
  const r = mkResult({ artifacts: ['r.json'] });
  const out = await scoreSandboxResult(r, {
    id: 'r', name: 'R', passThreshold: 1, weights: { a: 1 }, checks: { a: hasArtifact('r.json') },
  });
  assert.strictEqual(out.total, 100);
});

test('score: built-in durationUnderMs', async () => {
  const r = mkResult({ durationMs: 50 });
  const out = await scoreSandboxResult(r, {
    id: 'r', name: 'R', passThreshold: 1, weights: { a: 1 }, checks: { a: durationUnderMs(100) },
  });
  assert.strictEqual(out.total, 100);
});

test('score: allOf requires all', async () => {
  const r = mkResult();
  const rubric: RubricSpec = {
    id: 'r', name: 'R', passThreshold: 99,
    weights: { a: 1 }, checks: { a: allOf([exitCodeZero, noStderr]) },
  };
  const out1 = await scoreSandboxResult(r, rubric);
  assert.strictEqual(out1.total, 100);
  const out2 = await scoreSandboxResult(mkResult({ stderr: 'x' }), rubric);
  assert.strictEqual(out2.total, 0);
});

test('score: check throwing is coerced to 0', async () => {
  const r = mkResult();
  const out = await scoreSandboxResult(r, {
    id: 'r', name: 'R', passThreshold: 1, weights: { a: 1 },
    checks: { a: () => { throw new Error('boom'); } },
  });
  assert.strictEqual(out.total, 0);
});

test('score: non-finite check value is coerced to 0', async () => {
  const r = mkResult();
  const out = await scoreSandboxResult(r, {
    id: 'r', name: 'R', passThreshold: 1, weights: { a: 1 },
    checks: { a: () => Number.POSITIVE_INFINITY },
  });
  assert.strictEqual(out.total, 0);
});

test('score: passThreshold determines passed', async () => {
  const r = mkResult();
  const rubric: RubricSpec = {
    id: 'r', name: 'R', passThreshold: 80,
    weights: { a: 1 }, checks: { a: () => 0.7 },
  };
  const out = await scoreSandboxResult(r, rubric);
  assert.strictEqual(out.total, 70);
  assert.strictEqual(out.passed, false);
});

test('score: dim with no check contributes 0', async () => {
  const r = mkResult();
  const out = await scoreSandboxResult(r, {
    id: 'r', name: 'R', passThreshold: 1,
    weights: { a: 1, b: 1 }, checks: { a: () => 1 },
  });
  assert.strictEqual(out.total, 50);   // b missing → 0
});
