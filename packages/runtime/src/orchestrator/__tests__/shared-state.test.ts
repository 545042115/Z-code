// Unit tests for SharedState (blackboard semantics).
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { SharedState } from '../shared-state';

test('get returns undefined for missing key', () => {
  const s = new SharedState();
  assert.strictEqual(s.get('nope'), undefined);
});

test('set + get round-trips and tracks version', () => {
  const s = new SharedState();
  s.set('a', 1);
  s.set('a', 2);
  const snap = s.snapshot();
  assert.strictEqual(snap.a.value, 2);
  assert.strictEqual(snap.a.version, 2);
});

test('set deep-clones values to prevent aliasing', () => {
  const s = new SharedState();
  const obj = { x: 1, nested: { y: 2 } };
  s.set('o', obj);
  obj.x = 999;
  obj.nested.y = 999;
  const got = s.get<{ x: number; nested: { y: number } }>('o');
  assert.strictEqual(got?.x, 1);
  assert.strictEqual(got?.nested.y, 2);
});

test('has reflects presence', () => {
  const s = new SharedState();
  s.set('k', 'v');
  assert.strictEqual(s.has('k'), true);
  assert.strictEqual(s.has('k2'), false);
});

test('incr creates and increments', () => {
  const s = new SharedState();
  assert.strictEqual(s.incr('counter', 1, 'tester'), 1);
  assert.strictEqual(s.incr('counter', 5, 'tester'), 6);
  assert.strictEqual(s.get('counter'), 6);
});

test('subscribe fires on set, not on other keys', () => {
  const s = new SharedState();
  const got: number[] = [];
  s.subscribe<number>('n', (v) => got.push(v));
  s.set('n', 1);
  s.set('n', 2);
  s.set('other', 'x');
  assert.deepStrictEqual(got, [1, 2]);
});

test('subscribe returns unsubscribe function', () => {
  const s = new SharedState();
  const got: number[] = [];
  const off = s.subscribe<number>('n', (v) => got.push(v));
  s.set('n', 1);
  off();
  s.set('n', 2);
  assert.deepStrictEqual(got, [1]);
});

test('subscribeAny fires for every key', () => {
  const s = new SharedState();
  const keys: string[] = [];
  s.subscribeAny((k) => keys.push(k));
  s.set('a', 1);
  s.set('b', 2);
  assert.deepStrictEqual(keys, ['a', 'b']);
});

test('listener error does not block other listeners', () => {
  const s = new SharedState();
  const got: number[] = [];
  s.subscribe<number>('n', () => { throw new Error('bad'); });
  s.subscribe<number>('n', (v) => got.push(v));
  s.set('n', 7);
  assert.deepStrictEqual(got, [7]);
});

test('initial values are loaded', () => {
  const s = new SharedState({ initial: { a: 1, b: 'x' } });
  assert.strictEqual(s.get('a'), 1);
  assert.strictEqual(s.get('b'), 'x');
});

test('writer is recorded', () => {
  const s = new SharedState();
  s.set('k', 1, 'agent-a');
  s.set('k', 2, 'agent-b');
  const snap = s.snapshot();
  assert.strictEqual(snap.k.writer, 'agent-b');
});

test('delete removes the key', () => {
  const s = new SharedState();
  s.set('k', 1);
  assert.strictEqual(s.delete('k'), true);
  assert.strictEqual(s.has('k'), false);
});

test('size counts keys', () => {
  const s = new SharedState();
  assert.strictEqual(s.size(), 0);
  s.set('a', 1);
  s.set('b', 2);
  assert.strictEqual(s.size(), 2);
});
