// Unit tests for eval.ts helpers
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  combineScores,
  decidePass,
  DEFAULT_PASS_THRESHOLD,
  aggregateEvaluations,
  diffAggregates,
  type Evaluation,
  type EvaluatorResult,
} from '../eval';

const ev = (name: string, score: number): EvaluatorResult => ({
  name,
  scores: {},
  score,
});

test('combineScores: weighted average', () => {
  const r = combineScores(
    [ev('test', 100), ev('llm-judge', 80)],
    { test: 0.6, 'llm-judge': 0.4 },
  );
  // 100*0.6 + 80*0.4 = 60 + 32 = 92
  assert.strictEqual(r.total, 92);
  assert.deepStrictEqual(r.scores, { test: 100, 'llm-judge': 80 });
});

test('combineScores: ignores dimensions with weight 0', () => {
  const r = combineScores(
    [ev('test', 100), ev('unused', 0)],
    { test: 1.0, unused: 0 },
  );
  assert.strictEqual(r.total, 100);
});

test('combineScores: empty results => 0', () => {
  const r = combineScores([], { test: 1 });
  assert.strictEqual(r.total, 0);
  assert.deepStrictEqual(r.scores, {});
});

test('combineScores: weights not summing to 1 still work (re-normalize is N/A; raw weighted avg)', () => {
  // weightTotal=2, weightedSum = 100*2 = 200 -> 200/2 = 100
  const r = combineScores([ev('a', 100)], { a: 2 });
  assert.strictEqual(r.total, 100);
});

test('decidePass: above threshold passes', () => {
  assert.strictEqual(decidePass(80), true);
});

test('decidePass: at threshold passes', () => {
  assert.strictEqual(decidePass(DEFAULT_PASS_THRESHOLD), true);
});

test('decidePass: below threshold fails', () => {
  assert.strictEqual(decidePass(59), false);
});

test('decidePass: custom threshold', () => {
  assert.strictEqual(decidePass(70, 80), false);
  assert.strictEqual(decidePass(80, 80), true);
});

// ── aggregateEvaluations ──────────────────────────────────────────────

function mkEval(over: Partial<Evaluation> = {}): Evaluation {
  return {
    id: 'e-' + Math.random().toString(36).slice(2),
    runId: 'r1',
    benchmarkId: 'b1',
    scores: {},
    total: 80,
    pass: true,
    timestamp: 1000,
    durationMs: 100,
    ...over,
  };
}

test('aggregateEvaluations: empty list => zero aggregate', () => {
  const a = aggregateEvaluations([]);
  assert.strictEqual(a.count, 0);
  assert.strictEqual(a.passRate, 0);
  assert.strictEqual(a.passAt1, 0);
  assert.strictEqual(a.passAt3, 0);
  assert.strictEqual(a.avgScore, 0);
});

test('aggregateEvaluations: pass rate and avg score', () => {
  const evals = [
    mkEval({ total: 100, pass: true, timestamp: 1 }),
    mkEval({ total: 50, pass: false, timestamp: 2 }),
    mkEval({ total: 80, pass: true, timestamp: 3 }),
  ];
  const a = aggregateEvaluations(evals);
  assert.strictEqual(a.count, 3);
  assert.strictEqual(a.passCount, 2);
  assert.ok(Math.abs(a.passRate - 2 / 3) < 1e-9);
  assert.ok(Math.abs(a.avgScore - (100 + 50 + 80) / 3) < 1e-9);
  assert.ok(Math.abs(a.passAt1 - 2 / 3) < 1e-9);
  // Pass@3 = fraction of 3-windows with at least one pass.
  // With 3 evals ordered: [1 pass, 0 pass, 1 pass], the single 3-window has a pass.
  assert.strictEqual(a.passAt3, 1);
});

test('aggregateEvaluations: pass@3 = pass rate when fewer than 3 evals', () => {
  const evals = [mkEval({ pass: false }), mkEval({ pass: true })];
  const a = aggregateEvaluations(evals);
  assert.strictEqual(a.passAt3, a.passRate);
});

// ── diffAggregates ────────────────────────────────────────────────────

test('diffAggregates: positive diff for pass rate improvement', () => {
  const before = aggregateEvaluations([
    mkEval({ pass: true, total: 50 }),
    mkEval({ pass: false, total: 30 }),
  ]);
  const after = aggregateEvaluations([
    mkEval({ pass: true, total: 90 }),
    mkEval({ pass: true, total: 80 }),
  ]);
  const deltas = diffAggregates(before, after);
  const passRate = deltas.find((d) => d.metric === 'passRate');
  assert.ok(passRate);
  assert.ok(passRate!.diff > 0);
});

test('diffAggregates: improvement direction is reversed for duration', () => {
  const before = aggregateEvaluations([mkEval({ durationMs: 1000 })]);
  const after = aggregateEvaluations([mkEval({ durationMs: 500 })]);
  const deltas = diffAggregates(before, after);
  const dur = deltas.find((d) => d.metric === 'avgDurationMs');
  assert.ok(dur);
  assert.strictEqual(dur!.diff, -500);
});

test('diffAggregates: count delta', () => {
  const before = aggregateEvaluations([mkEval()]);
  const after = aggregateEvaluations([mkEval(), mkEval()]);
  const deltas = diffAggregates(before, after);
  const count = deltas.find((d) => d.metric === 'count');
  assert.ok(count);
  assert.strictEqual(count!.diff, 1);
});
