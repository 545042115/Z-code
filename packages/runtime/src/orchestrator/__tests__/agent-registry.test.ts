// Unit tests for AgentRegistry.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  AgentRegistry,
  AgentConflictError,
  AgentNotFoundError,
  DependencyCycleError,
} from '../agent-registry';
import { NoopAgent } from '../orchestrator';
import type { IAgent, TaskContext } from '@ziner/contracts';

function mkAgent(name: string, caps: string[] = [], deps: string[] = []): IAgent {
  return {
    name,
    role: name,
    capabilities: caps,
    dependencies: deps,
    canHandle: () => 1,
    execute: async () => ({ ok: true }),
  };
}

test('register + get', () => {
  const r = new AgentRegistry();
  r.register(NoopAgent);
  assert.strictEqual(r.get('noop').name, 'noop');
});

test('register duplicate throws AgentConflictError', () => {
  const r = new AgentRegistry();
  r.register(mkAgent('a'));
  assert.throws(() => r.register(mkAgent('a')), AgentConflictError);
});

test('unregister removes an agent', () => {
  const r = new AgentRegistry();
  r.register(mkAgent('a'));
  assert.strictEqual(r.unregister('a'), true);
  assert.strictEqual(r.has('a'), false);
  assert.strictEqual(r.unregister('a'), false);
});

test('get missing throws AgentNotFoundError', () => {
  const r = new AgentRegistry();
  assert.throws(() => r.get('nope'), AgentNotFoundError);
});

test('list returns all agents sorted by name', () => {
  const r = new AgentRegistry();
  r.register(mkAgent('b'));
  r.register(mkAgent('a'));
  r.register(mkAgent('c'));
  assert.deepStrictEqual(r.list().map((a) => a.name), ['a', 'b', 'c']);
});

test('byCapability returns matching agents', () => {
  const r = new AgentRegistry();
  r.register(mkAgent('a', ['search']));
  r.register(mkAgent('b', ['search', 'code']));
  r.register(mkAgent('c', ['review']));
  const out = r.byCapability('search').map((a) => a.name);
  assert.deepStrictEqual(out.sort(), ['a', 'b']);
});

test('rank returns scored agents, sorted descending', async () => {
  const r = new AgentRegistry();
  r.register({ ...mkAgent('a', ['x']), canHandle: () => 0.3 });
  r.register({ ...mkAgent('b', ['x']), canHandle: () => 0.9 });
  r.register({ ...mkAgent('c', ['x']), canHandle: () => 0 });   // excluded
  const ranked = await r.rank({} as TaskContext);
  assert.deepStrictEqual(ranked.map((x) => x.agent.name), ['b', 'a']);
});

test('rank tolerates async canHandle', async () => {
  const r = new AgentRegistry();
  r.register({ ...mkAgent('a'), canHandle: async () => 0.5 });
  const ranked = await r.rank({} as TaskContext);
  assert.strictEqual(ranked[0].score, 0.5);
});

test('rank tolerates throwing canHandle', async () => {
  const r = new AgentRegistry();
  r.register({ ...mkAgent('a'), canHandle: () => { throw new Error('boom'); } });
  r.register(mkAgent('b'));
  const ranked = await r.rank({} as TaskContext);
  assert.strictEqual(ranked.length, 1);
  assert.strictEqual(ranked[0].agent.name, 'b');
});

test('bestFor picks the highest scorer', async () => {
  const r = new AgentRegistry();
  r.register({ ...mkAgent('a'), canHandle: () => 0.1 });
  r.register({ ...mkAgent('b'), canHandle: () => 0.9 });
  const best = await r.bestFor({} as TaskContext);
  assert.strictEqual(best?.name, 'b');
});

test('bestFor returns undefined when no agent scores > 0', async () => {
  const r = new AgentRegistry();
  r.register({ ...mkAgent('a'), canHandle: () => 0 });
  assert.strictEqual(await r.bestFor({} as TaskContext), undefined);
});

test('resolveOrder returns dependencies first', () => {
  const r = new AgentRegistry();
  r.register(mkAgent('coder', [], ['researcher']));
  r.register(mkAgent('reviewer', [], ['coder']));
  r.register(mkAgent('researcher'));
  const order = r.resolveOrder(['reviewer', 'coder', 'researcher']);
  assert.deepStrictEqual(order, ['researcher', 'coder', 'reviewer']);
});

test('resolveOrder throws DependencyCycleError on cycle', () => {
  const r = new AgentRegistry();
  r.register(mkAgent('a', [], ['b']));
  r.register(mkAgent('b', [], ['a']));
  assert.throws(() => r.resolveOrder(['a', 'b']), DependencyCycleError);
});

test('resolveOrder skips out-of-scope dependencies', () => {
  const r = new AgentRegistry();
  r.register(mkAgent('a', [], ['external']));   // 'external' not in scope
  r.register(mkAgent('b'));
  const order = r.resolveOrder(['a', 'b']);
  assert.deepStrictEqual(order, ['a', 'b']);
});
