// Unit tests for cost module
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { computeCost, lookupPrice, DEFAULT_PRICING } from '../pricing';
import { BudgetGuard, BudgetExceededError } from '../budget';
import { AgentErrorCode } from '@z-assistant/infra-errors';

test('lookupPrice: known model', () => {
  const p = lookupPrice({ provider: 'openai', name: 'gpt-4o' });
  assert.ok(p);
  assert.strictEqual(p?.inputPer1k, 0.0025);
});

test('lookupPrice: unknown model => undefined', () => {
  assert.strictEqual(lookupPrice({ provider: 'x', name: 'y' }), undefined);
});

test('computeCost: standard model', () => {
  const usd = computeCost({ provider: 'openai', name: 'gpt-4o' }, 1000, 500);
  // (1000/1000)*0.0025 + (500/1000)*0.01 = 0.0025 + 0.005 = 0.0075
  assert.strictEqual(usd, 0.0075);
});

test('computeCost: sglang local is free', () => {
  const usd = computeCost({ provider: 'sglang', name: 'default' }, 1_000_000, 1_000_000);
  assert.strictEqual(usd, 0);
});

test('computeCost: unknown model => 0 (no crash)', () => {
  const usd = computeCost({ provider: 'x', name: 'y' }, 1000, 1000);
  assert.strictEqual(usd, 0);
});

test('DEFAULT_PRICING: contains expected providers', () => {
  assert.ok(DEFAULT_PRICING['openai/gpt-4o']);
  assert.ok(DEFAULT_PRICING['deepseek/deepseek-chat']);
});

test('BudgetGuard: tracks tokens and cost', () => {
  BudgetGuard.resetDayCounter();
  const g = new BudgetGuard({ perRunUsd: 1.0, perDayUsd: 100, perRunTokens: 100_000 });
  g.consume(1000, 0.01);
  g.consume(2000, 0.02);
  const snap = g.snapshot();
  assert.strictEqual(snap.tokensLeft, 97_000);
  assert.strictEqual(snap.costLeftUsd, 0.97);
});

test('BudgetGuard: throws on per-run token cap', () => {
  BudgetGuard.resetDayCounter();
  const g = new BudgetGuard({ perRunUsd: 100, perDayUsd: 1000, perRunTokens: 100 });
  g.consume(50, 0);
  assert.throws(() => g.consume(60, 0), BudgetExceededError);
});

test('BudgetGuard: throws on per-run USD cap', () => {
  BudgetGuard.resetDayCounter();
  const g = new BudgetGuard({ perRunUsd: 0.1, perDayUsd: 100, perRunTokens: 100_000 });
  assert.throws(() => g.consume(0, 0.2), BudgetExceededError);
});

test('BudgetGuard: BudgetExceededError carries AgentErrorCode', () => {
  BudgetGuard.resetDayCounter();
  const g = new BudgetGuard({ perRunUsd: 0.01, perDayUsd: 100, perRunTokens: 100_000 });
  try {
    g.consume(0, 0.1);
    assert.fail('should have thrown');
  } catch (e) {
    assert.ok(e instanceof BudgetExceededError);
    assert.strictEqual((e as BudgetExceededError).code, AgentErrorCode.BudgetExceeded);
    assert.strictEqual((e as BudgetExceededError).category, 'agent');
  }
});
