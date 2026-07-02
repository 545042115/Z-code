// Tests for the V2 Coding Agent adapter layer.
//
// Phase 6A: each sub-adapter is a stub that returns a known
// failure code. These tests pin the public API shape so R7 can
// swap the impls without changing call sites.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  CodingAgent,
  CodingPlanner,
  CodingReflectionEngine,
  CodingContextProvider,
  CodingSkillRegistry,
  CodingToolRegistry,
  CodingVerifier,
  CodingAgentLoop,
  createCodingAgentLoop,
} from '../src';
import type { TaskContext, AgentResult, Plan, PlanResult, VerifierOutput, ContextChunk, SkillSpec, IPlanner, IVerifier, IContextProvider, ISkillRegistry } from '@ziner/contracts';

function mkCtx(): TaskContext {
  return {
    task: 'fix the failing test',
    model: { provider: 'p', name: 'n' },
    sessionId: 's1',
    sharedState: { get: () => undefined, set: () => undefined, has: () => false, delete: () => false, incr: () => 0, size: () => 0, snapshot: () => ({}), subscribe: () => () => undefined, subscribeAny: () => () => undefined },
    parentRunId: 'r1',
    traceId: 't1',
    budget: { tokensLeft: 1_000_000, costLeftUsd: 1.0 },
  };
}

test('CodingAgent: stub returns 3001', async () => {
  const a = new CodingAgent();
  const r = await a.execute(mkCtx());
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error?.code, '3001');
});

test('CodingPlanner: stub returns empty plan', async () => {
  const p = new CodingPlanner();
  const plan = await p.buildPlan(mkCtx());
  assert.strictEqual(plan.id, 'stub-plan');
  assert.deepStrictEqual(plan.steps, []);
});

test('CodingPlanner: stub execute returns 3001', async () => {
  const p = new CodingPlanner();
  const out = await p.execute({ id: 'p', name: 'p', steps: [] }, mkCtx());
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.error?.code, '3001');
});

test('CodingReflection: stub returns continue', async () => {
  const r = new CodingReflectionEngine();
  const d = await r.reflect(mkCtx(), { ok: true }, undefined, 0, 3);
  assert.strictEqual(d.action, 'continue');
  assert.strictEqual(d.confidence, 0);
});

test('CodingContext: stub fetch returns []', async () => {
  const c = new CodingContextProvider();
  const out = await c.fetch(mkCtx(), 'q');
  assert.deepStrictEqual(out, []);
});

test('CodingSkill: stub select returns registered skills', async () => {
  const s = new CodingSkillRegistry();
  s.register({ id: 'a', name: 'A', tags: [], body: 'b' });
  s.register({ id: 'b', name: 'B', tags: [], body: 'b' });
  const out = await s.select(mkCtx(), 5);
  assert.strictEqual(out.length, 2);
});

test('CodingTool: stub invoke returns 3001', async () => {
  const t = new CodingToolRegistry();
  const out = await t.invoke({ id: '1', toolName: 'edit_file', args: {} });
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.error?.code, '3001');
});

test('CodingTool: register / unregister / get', () => {
  const t = new CodingToolRegistry();
  t.register({ name: 'x', description: 'x', capabilities: [], invoke: async () => ({ ok: true }) });
  assert.deepStrictEqual(t.list(), ['x']);
  assert.ok(t.get('x'));
  assert.strictEqual(t.unregister('x'), true);
  assert.deepStrictEqual(t.list(), []);
});

test('CodingVerifier: stub returns fail', async () => {
  const v = new CodingVerifier();
  const out = await v.verify({ ok: true });
  assert.strictEqual(out.pass, false);
  assert.deepStrictEqual(out.diagnostics, []);
});

test('CodingAgentLoop: wires all sub-adapters', () => {
  const loop = createCodingAgentLoop();
  assert.ok(loop.agent instanceof CodingAgent);
  assert.ok(loop.planner instanceof CodingPlanner);
  assert.ok(loop.reflection instanceof CodingReflectionEngine);
  assert.ok(loop.context instanceof CodingContextProvider);
  assert.ok(loop.skills instanceof CodingSkillRegistry);
  assert.ok(loop.tools instanceof CodingToolRegistry);
  assert.ok(loop.verifier instanceof CodingVerifier);
});

test('CodingAgentLoop.asIAgent returns the agent', () => {
  const loop = createCodingAgentLoop();
  const iAgent = loop.asIAgent();
  assert.strictEqual(iAgent.name, 'coding');
});

test('CodingPlanner: impl override is used', async () => {
  const fakePlan: Plan = { id: 'real', name: 'real', steps: [] };
  const fakeResult: PlanResult = { ok: true, steps: [], totalDurationMs: 1 };
  const impl: IPlanner = {
    name: 'real-planner',
    buildPlan: async () => fakePlan,
    execute: async () => fakeResult,
  };
  const p = new CodingPlanner({ impl });
  const plan = await p.buildPlan(mkCtx());
  assert.strictEqual(plan.id, 'real');
  const r = await p.execute(plan, mkCtx());
  assert.strictEqual(r.ok, true);
});

test('CodingVerifier: impl override is used', async () => {
  const out: VerifierOutput = { pass: true, stages: {}, diagnostics: [], durationMs: 0 };
  const impl: IVerifier = { name: 'real', verify: async () => out };
  const v = new CodingVerifier({ impl: impl.verify });
  const r = await v.verify({ ok: true });
  assert.strictEqual(r.pass, true);
});

test('CodingContext: impl override is used', async () => {
  const chunks: ContextChunk[] = [{ id: '1', source: 's', content: 'c', score: 1, tags: [] }];
  const impl: IContextProvider = { name: 'real', fetch: async () => chunks, source: () => ({ name: 'real', role: 'r', priority: 1 }) };
  const c = new CodingContextProvider({ impl });
  const out = await c.fetch(mkCtx(), 'q');
  assert.deepStrictEqual(out, chunks);
});

test('CodingSkill: impl override is used', async () => {
  const skills: SkillSpec[] = [{ id: 'x', name: 'X', tags: [], body: 'b' }];
  const impl: ISkillRegistry = {
    name: 'real',
    register: () => undefined,
    unregister: () => false,
    get: async (id) => skills.find((s) => s.id === id) ?? null,
    list: async () => skills,
    select: async () => [],
  };
  const s = new CodingSkillRegistry({ impl });
  const out = await s.list();
  assert.deepStrictEqual(out, skills);
});
