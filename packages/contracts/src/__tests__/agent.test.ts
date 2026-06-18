// Unit tests for agent.ts helpers
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { ok, fail } from '../agent';

test('ok(): builds a success result with output', () => {
  const r = ok({ a: 1 });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.output, { a: 1 });
  assert.strictEqual(r.error, undefined);
});

test('ok(): supports extra fields (artifacts, metrics)', () => {
  const r = ok('result', {
    artifacts: { 'k': 'v' },
    metrics: { tokensIn: 1, tokensOut: 2, costUsd: 0.01, durationMs: 100, llmCalls: 1, toolCalls: 0 },
  });
  assert.deepStrictEqual(r.artifacts, { 'k': 'v' });
  assert.strictEqual(r.metrics?.costUsd, 0.01);
});

test('fail(): builds a failure with code + message', () => {
  const r = fail('2002', 'permission denied');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.output, undefined);
  assert.deepStrictEqual(r.error, { code: '2002', message: 'permission denied' });
});

test('fail(): preserves extras', () => {
  const r = fail('3001', 'timeout', { metrics: { tokensIn: 0, tokensOut: 0, costUsd: 0, durationMs: 30000, llmCalls: 0, toolCalls: 0 } });
  assert.strictEqual(r.metrics?.durationMs, 30000);
});
