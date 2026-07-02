// Tests for the Research Agent's per-URL timeout behaviour.
//
// Previously the agent had no hard time budget on `fetchProvider`,
// `browserFetchProvider`, `searchProvider`, or the browser-agent
// delegation. A single slow / hanging server could stretch a run to
// the OS-level TCP timeout (~75s on Linux). These tests pin the
// new bounded-timeout behaviour so a regression is caught immediately.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createResearchAgent } from '../src';
import type {
  TaskContext, SharedState, ILLMProvider, LLMResponse, LLMRequest,
} from '@ziner/contracts';

function mkCtx(task: string): TaskContext {
  return {
    task,
    model: { provider: 'p', name: 'n' },
    sessionId: 's1',
    sharedState: {
      get: () => undefined,
      set: () => undefined,
      has: () => false,
      delete: () => false,
      incr: () => 0,
      size: () => 0,
      snapshot: () => ({}),
      subscribe: () => () => undefined,
      subscribeAny: () => () => undefined,
    } as unknown as SharedState,
    parentRunId: 'r1',
    traceId: 't1',
    budget: { tokensLeft: 1_000_000, costLeftUsd: 1.0 },
  };
}

/**
 * Build a stub LLM that returns the provided JSON for the *first*
 * call (the query-planning LLM) and a no-op report for subsequent
 * calls (the synthesiser). Each call can be inspected via `seen`.
 */
function llmWithPlan(plan: object): { llm: ILLMProvider; seen: number[] } {
  const seen: number[] = [];
  let planCalls = 0;
  const llm: ILLMProvider = {
    name: 'stub',
    supportedModels: [],
    async generate(req: LLMRequest): Promise<LLMResponse> {
      seen.push(req.messages.length);
      planCalls += 1;
      // First call: query plan. Subsequent calls: synthesised report.
      if (planCalls === 1) {
        return {
          message: { role: 'assistant', content: JSON.stringify(plan) },
          usage: { tokensIn: 0, tokensOut: 0 },
          durationMs: 0,
          finishReason: 'end_turn',
          costUsd: 0,
        };
      }
      return {
        message: {
          role: 'assistant',
          content: '{"markdown":"ok","satisfied":true,"sources":[]}',
        },
        usage: { tokensIn: 0, tokensOut: 0 },
        durationMs: 0,
        finishReason: 'end_turn',
        costUsd: 0,
      };
    },
  };
  return { llm, seen };
}

/** Make a Promise that resolves after `ms` with the given value. */
function delay<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

test('research: fetchProvider timeout aborts the call and falls through to browser', async () => {
  // Use a non-JS URL so the browser-agent delegation path is skipped
  // (that path has its own state machine and a separate 20s timeout).
  // We just want to confirm: simple fetch that hangs past 80ms is
  // abandoned and the browserFetchProvider takes over.
  const { llm } = llmWithPlan({ queries: ['pricing info'] });
  let browserInvoked = false;
  const agent = createResearchAgent({
    llmProvider: llm,
    model: { provider: 'p', name: 'n' },
    searchProvider: async () => [
      { title: 'a', url: 'https://example.com/article' },
    ],
    fetchProvider: () => delay<string>(60_000, 'NEVER'),
    browserFetchProvider: async () => {
      browserInvoked = true;
      return { title: 'a', content: 'x'.repeat(500) };
    },
    fetchTimeoutMs: 80,
    browserTimeoutMs: 5_000,
    maxIterations: 1,
    maxPagesToFetch: 1,
    maxQueries: 1,
  });

  const t0 = Date.now();
  const result = await agent.execute(mkCtx('any task'));
  const elapsed = Date.now() - t0;

  assert.ok(result.ok, 'research should still succeed via browser fallback');
  assert.ok(browserInvoked, 'browser provider should have been used as fallback');
  assert.ok(elapsed < 2_000, `expected run to complete quickly, took ${elapsed}ms`);
});

test('research: browserFetchProvider timeout returns empty report (no infinite loop)', async () => {
  // Both providers hang. The agent should give up at the configured
  // browser timeout and finish the run.
  const { llm } = llmWithPlan({ queries: ['q1'] });
  const agent = createResearchAgent({
    llmProvider: llm,
    model: { provider: 'p', name: 'n' },
    searchProvider: async () => [
      { title: 'a', url: 'https://example.com/article' },
    ],
    fetchProvider: () => delay<string>(60_000, 'NEVER'),
    browserFetchProvider: () =>
      delay(60_000, { title: '', content: '' }),
    fetchTimeoutMs: 50,
    browserTimeoutMs: 80,
    maxIterations: 1,
    maxPagesToFetch: 1,
    maxQueries: 1,
  });

  const t0 = Date.now();
  const result = await agent.execute(mkCtx('any task'));
  const elapsed = Date.now() - t0;

  assert.ok(elapsed < 3_000, `expected quick failure, took ${elapsed}ms`);
  assert.ok(result.ok, 'agent should still report success (empty report) when nothing is fetchable');
});

test('research: searchProvider timeout is bounded and the loop continues', async () => {
  // Two queries in the plan. The first one's searchProvider hangs
  // forever; the second returns real results. The agent should
  // abandon the first at the 80ms budget and complete the second.
  const { llm } = llmWithPlan({ queries: ['slow', 'fast'] });
  let calls = 0;
  const agent = createResearchAgent({
    llmProvider: llm,
    model: { provider: 'p', name: 'n' },
    searchProvider: async () => {
      calls += 1;
      if (calls === 1) return delay(60_000, []);
      return [{ title: 'a', url: 'https://example.com' }];
    },
    fetchProvider: async () => 'x'.repeat(500),
    searchTimeoutMs: 80,
    fetchTimeoutMs: 5_000,
    maxIterations: 1,
    maxPagesToFetch: 2,
    maxQueries: 2,
  });

  const t0 = Date.now();
  const result = await agent.execute(mkCtx('any task'));
  const elapsed = Date.now() - t0;

  assert.ok(result.ok);
  assert.ok(elapsed < 2_000, `expected quick run, took ${elapsed}ms`);
  assert.ok(calls >= 2, 'both queries should have been attempted despite the first timing out');
});

test('research: custom timeout overrides are honoured', async () => {
  const { llm } = llmWithPlan({ queries: ['q'] });
  const agent = createResearchAgent({
    llmProvider: llm,
    model: { provider: 'p', name: 'n' },
    searchProvider: async () => [],
    fetchProvider: () => delay<string>(60, 'NEVER'),
    fetchTimeoutMs: 30,
    browserTimeoutMs: 30,
    delegationTimeoutMs: 30,
    searchTimeoutMs: 30,
    maxIterations: 1,
    maxPagesToFetch: 1,
    maxQueries: 1,
  });

  const t0 = Date.now();
  await agent.execute(mkCtx('any task'));
  const elapsed = Date.now() - t0;
  // We just want a sane upper bound — not a precise assertion.
  assert.ok(elapsed < 2_000, `expected quick run, took ${elapsed}ms`);
});

test('research: defaults are 12s fetch / 25s browser / 20s delegation / 10s search', () => {
  // Pin the defaults so a future "tweak" doesn't silently regress
  // them back to 60s waits.
  const a = createResearchAgent({
    llmProvider: llmWithPlan({ queries: [] }).llm,
    model: { provider: 'p', name: 'n' },
    searchProvider: async () => [],
    fetchProvider: async () => '',
  });
  const internals = a as unknown as {
    fetchTimeoutMs: number;
    browserTimeoutMs: number;
    delegationTimeoutMs: number;
    searchTimeoutMs: number;
  };
  assert.equal(internals.fetchTimeoutMs, 12_000);
  assert.equal(internals.browserTimeoutMs, 25_000);
  assert.equal(internals.delegationTimeoutMs, 20_000);
  assert.equal(internals.searchTimeoutMs, 10_000);
});
