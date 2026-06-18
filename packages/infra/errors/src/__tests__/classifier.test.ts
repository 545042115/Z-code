// Unit tests for errors module
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  ALL_ERROR_CODES,
  AgentErrorCode,
  LlmErrorCode,
  StorageErrorCode,
  ToolErrorCode,
  UnknownErrorCode,
  classify,
  describeErrorCode,
  toErrorRef,
} from '../index';

test('ALL_ERROR_CODES contains a sample from each category', () => {
  assert.ok(ALL_ERROR_CODES.has(LlmErrorCode.RateLimit));
  assert.ok(ALL_ERROR_CODES.has(ToolErrorCode.PermissionDenied));
  assert.ok(ALL_ERROR_CODES.has(AgentErrorCode.BudgetExceeded));
  assert.ok(ALL_ERROR_CODES.has(StorageErrorCode.IoError));
  assert.ok(ALL_ERROR_CODES.has(UnknownErrorCode.Unexpected));
});

test('classify: null/undefined', () => {
  assert.strictEqual(classify(null).code, UnknownErrorCode.Unexpected);
  assert.strictEqual(classify(undefined).category, 'unknown');
});

test('classify: string', () => {
  const c = classify('boom');
  assert.strictEqual(c.code, UnknownErrorCode.Unexpected);
  assert.strictEqual(c.message, 'boom');
  assert.strictEqual(c.cause, 'String');
});

test('classify: ENOENT -> NotFound', () => {
  const c = classify({ code: 'ENOENT', message: 'nope' });
  assert.strictEqual(c.code, ToolErrorCode.NotFound);
  assert.strictEqual(c.category, 'tool');
});

test('classify: EACCES -> PermissionDenied', () => {
  const c = classify({ code: 'EACCES', message: 'denied' });
  assert.strictEqual(c.code, ToolErrorCode.PermissionDenied);
  assert.strictEqual(c.category, 'tool');
});

test('classify: ETIMEDOUT -> Timeout', () => {
  const c = classify({ code: 'ETIMEDOUT', message: 'slow' });
  assert.strictEqual(c.code, ToolErrorCode.Timeout);
});

test('classify: HTTP 429 -> RateLimit', () => {
  const c = classify({ status: 429, message: 'too many' });
  assert.strictEqual(c.code, LlmErrorCode.RateLimit);
});

test('classify: HTTP 401 -> AuthFailed', () => {
  const c = classify({ status: 401, message: 'unauthorized' });
  assert.strictEqual(c.code, LlmErrorCode.AuthFailed);
});

test('classify: HTTP 500 -> ProviderUnreachable', () => {
  const c = classify({ status: 503, message: 'oops' });
  assert.strictEqual(c.code, LlmErrorCode.ProviderUnreachable);
});

test('classify: message heuristic for context overflow', () => {
  const c = classify(new Error('context length exceeded maximum'));
  assert.strictEqual(c.code, LlmErrorCode.ContextOverflow);
  assert.strictEqual(c.category, 'llm');
});

test('classify: message heuristic for budget', () => {
  const c = classify(new Error('cost limit reached'));
  assert.strictEqual(c.code, AgentErrorCode.BudgetExceeded);
  assert.strictEqual(c.category, 'agent');
});

test('classify: already-classified code passes through', () => {
  const c = classify({ code: '2002', message: 'denied' });
  assert.strictEqual(c.code, '2002');
  assert.strictEqual(c.category, 'tool');
});

test('classify: unknown Error -> Unexpected', () => {
  const c = classify(new TypeError('whatever'));
  assert.strictEqual(c.code, UnknownErrorCode.Unexpected);
  assert.strictEqual(c.category, 'unknown');
  assert.strictEqual(c.cause, 'TypeError');
});

test('describeErrorCode: returns human label', () => {
  assert.strictEqual(describeErrorCode('2002'), 'Tool / permission error');
  assert.strictEqual(describeErrorCode('3001'), 'Agent error');
  // '9' prefix maps to "Unknown error" by design
  assert.strictEqual(describeErrorCode('9999'), 'Unknown error');
  // empty / unrecognized
  assert.strictEqual(describeErrorCode(''), 'Unrecognized error');
});

test('toErrorRef: drops category and stack', () => {
  const c = classify({ code: '1001', message: 'rate' });
  const r = toErrorRef(c);
  assert.strictEqual(r.code, '1001');
  assert.strictEqual(r.message, 'rate');
  assert.strictEqual(r.stack, undefined);
});
