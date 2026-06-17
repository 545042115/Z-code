// Unit tests for PromptedAgent — the A/B variant wrapper.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { PromptedAgent, PROMPT_METADATA_KEYS } from '../prompted-agent';
import type { IAgent, TaskContext, AgentResult, PromptCandidate, PromptVariant } from '../../contracts';
import { ok } from '../../contracts';
import type { QueryService } from '../../trace-ui/query-service';

function makeCtx(metadata: Record<string, string | number | boolean | null> = {}): TaskContext {
  return {
    task: 't',
    model: { provider: 'p', name: 'n' },
    sessionId: 's1',
    parentRunId: 'r1',
    traceId: 't1',
    sharedState: { get: () => undefined, set: () => undefined, has: () => false, delete: () => false, incr: () => 0, size: () => 0, snapshot: () => ({}), subscribe: () => () => undefined, subscribeAny: () => () => undefined } as unknown as TaskContext['sharedState'],
    budget: { tokensLeft: 1000, costLeftUsd: 1 },
    metadata,
  };
}

const baseAgent: IAgent = {
  name: 'researcher',
  role: 'Researcher',
  capabilities: ['research'],
  dependencies: [],
  execute: async (ctx: TaskContext): Promise<AgentResult> => ok({ seen: ctx.metadata?.[PROMPT_METADATA_KEYS.promptActive] }),
};

function makeVariant(id: string, label: string, content: string, createdAt = 1): PromptVariant {
  return { id, label, content, createdAt };
}

function makeCandidate(id: string, agentName: string, variants: PromptVariant[], activeVariantId: string, createdAt = 1): PromptCandidate {
  return { id, agentName, name: id, variants, activeVariantId, createdAt, updatedAt: createdAt };
}

function makeFakeQuery(list: PromptCandidate[] = []): QueryService {
  return {
    listCandidates: async ({ agentName }: { agentName?: string } = {}) => {
      if (!agentName) return list;
      return list.filter((c) => c.agentName === agentName);
    },
  } as unknown as QueryService;
}

test('PromptedAgent: no candidate → no variant metadata, base runs unchanged', async () => {
  const w = new PromptedAgent({ base: baseAgent, query: makeFakeQuery() });
  const ctx = makeCtx();
  const r = await w.execute(ctx);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(ctx.metadata?.[PROMPT_METADATA_KEYS.variantId], undefined);
  assert.strictEqual(ctx.metadata?.[PROMPT_METADATA_KEYS.promptActive], undefined);
});

test('PromptedAgent: active variant is surfaced in ctx.metadata', async () => {
  const v1 = makeVariant('v1', 'control', 'You are a careful researcher.');
  const v2 = makeVariant('v2', 'A', 'You are a bold researcher.');
  const cand = makeCandidate('researcher:default', 'researcher', [v1, v2], 'v2');
  const w = new PromptedAgent({ base: baseAgent, query: makeFakeQuery([cand]) });
  const ctx = makeCtx();
  await w.execute(ctx);
  assert.strictEqual(ctx.metadata?.[PROMPT_METADATA_KEYS.variantId], 'v2');
  assert.strictEqual(ctx.metadata?.[PROMPT_METADATA_KEYS.variantLabel], 'A');
  assert.strictEqual(ctx.metadata?.[PROMPT_METADATA_KEYS.promptActive], 'You are a bold researcher.');
  assert.strictEqual(ctx.metadata?.[PROMPT_METADATA_KEYS.candidateId], 'researcher:default');
});

test('PromptedAgent: dangling activeVariantId is ignored (defensive)', async () => {
  const v1 = makeVariant('v1', 'control', 'prompt');
  const cand = makeCandidate('c', 'researcher', [v1], 'v-missing');
  const w = new PromptedAgent({ base: baseAgent, query: makeFakeQuery([cand]) });
  const ctx = makeCtx();
  await w.execute(ctx);
  // No variantId should be set since the active one is not in variants.
  assert.strictEqual(ctx.metadata?.[PROMPT_METADATA_KEYS.variantId], undefined);
});

test('PromptedAgent: query error is swallowed and base still runs', async () => {
  const q: QueryService = {
    listCandidates: async () => { throw new Error('storage down'); },
  } as unknown as QueryService;
  const w = new PromptedAgent({ base: baseAgent, query: q });
  const ctx = makeCtx();
  const r = await w.execute(ctx);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(ctx.metadata?.[PROMPT_METADATA_KEYS.variantId], undefined);
});

test('PromptedAgent: swallowErrors=false surfaces the query error', async () => {
  const q: QueryService = {
    listCandidates: async () => { throw new Error('storage down'); },
  } as unknown as QueryService;
  const w = new PromptedAgent({ base: baseAgent, query: q, swallowErrors: false });
  const ctx = makeCtx();
  await assert.rejects(w.execute(ctx), /storage down/);
});

test('PromptedAgent: proxies canHandle, role, capabilities, dependencies', () => {
  const w = new PromptedAgent({ base: baseAgent, query: makeFakeQuery() });
  assert.strictEqual(w.name, 'researcher');
  assert.strictEqual(w.role, 'Researcher');
  assert.deepStrictEqual(w.capabilities, ['research']);
  assert.deepStrictEqual(w.dependencies, []);
  assert.strictEqual(w.canHandle?.(makeCtx()), undefined);  // base has no canHandle
});
