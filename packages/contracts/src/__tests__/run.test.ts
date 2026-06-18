// Unit tests for run.ts helpers
// Run via: node --test out/contracts/__tests__/run.test.js
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  computeDuration,
  isRunFinished,
  isSpanFinished,
} from '../run';

test('computeDuration: returns undefined when endTime is missing', () => {
  assert.strictEqual(computeDuration(100, undefined), undefined);
});

test('computeDuration: returns positive ms when finished', () => {
  assert.strictEqual(computeDuration(1000, 1500), 500);
});

test('computeDuration: clamps negative to zero (clock skew safety)', () => {
  assert.strictEqual(computeDuration(2000, 1500), 0);
});

test('computeDuration: handles same ms', () => {
  assert.strictEqual(computeDuration(1000, 1000), 0);
});

test('isRunFinished: running is not finished', () => {
  assert.strictEqual(isRunFinished('running'), false);
});

test('isRunFinished: success/failed/cancelled are finished', () => {
  assert.strictEqual(isRunFinished('success'), true);
  assert.strictEqual(isRunFinished('failed'), true);
  assert.strictEqual(isRunFinished('cancelled'), true);
});

test('isSpanFinished: ok/error/cancelled are finished', () => {
  assert.strictEqual(isSpanFinished('ok'), true);
  assert.strictEqual(isSpanFinished('error'), true);
  assert.strictEqual(isSpanFinished('cancelled'), true);
});
