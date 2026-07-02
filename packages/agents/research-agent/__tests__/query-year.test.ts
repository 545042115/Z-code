// Tests for the year-normalization in query planning.
//
// The research agent's `planQueries` LLM is told "use the current
// year (2026) when the user wants the latest news", but models
// trained before 2026 often default to 2024/2025 because of
// training-data inertia. We post-process the LLM's output to
// rewrite any 4-digit year in 2020-2030 to the current year, so a
// stale "2024" or "2025" suffix never lands in the search query.

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

const currentYear = new Date().getFullYear();

/** Build an LLM that returns the given plan as the first call's response. */
function llmWithPlan(plan: object, followUp?: object): ILLMProvider {
  let calls = 0;
  return {
    name: 'stub',
    supportedModels: [],
    async generate(_req: LLMRequest): Promise<LLMResponse> {
      calls += 1;
      if (calls === 1) {
        return {
          message: { role: 'assistant', content: JSON.stringify(plan) },
          usage: { tokensIn: 0, tokensOut: 0 },
          durationMs: 0,
          finishReason: 'end_turn',
          costUsd: 0,
        };
      }
      // Synthesiser + reflection.
      return {
        message: {
          role: 'assistant',
          content: JSON.stringify(
            followUp ?? { markdown: 'ok', satisfied: true, sources: [] },
          ),
        },
        usage: { tokensIn: 0, tokensOut: 0 },
        durationMs: 0,
        finishReason: 'end_turn',
        costUsd: 0,
      };
    },
  };
}

test('research: stale 2025/2024 year suffix is rewritten to current year', async () => {
  // Simulate an LLM that still adds 2025 / 2024 to recency queries
  // (because its training data cuts off in early 2026).
  const llm = llmWithPlan({
    queries: [
      'GLM 定价 2025',
      '最新 token 套餐 2024',
      'OpenAI pricing 2026',
    ],
  });
  const capturedQueries: string[] = [];
  const agent = createResearchAgent({
    llmProvider: llm,
    model: { provider: 'p', name: 'n' },
    searchProvider: async (q) => {
      capturedQueries.push(q);
      return [{ title: 'a', url: 'https://example.com' }];
    },
    fetchProvider: async () => 'x'.repeat(500),
    maxIterations: 1,
    maxPagesToFetch: 1,
    maxQueries: 3,
  });

  await agent.execute(mkCtx('最新 LLM 定价'));

  // The 2025 and 2024 suffixes should have been rewritten to the
  // current year; the 2026 suffix should have been left alone.
  const y = String(currentYear);
  assert.deepEqual(
    capturedQueries,
    [`GLM 定价 ${y}`, `最新 token 套餐 ${y}`, `OpenAI pricing ${y}`],
    `stale year suffixes should be rewritten to current year (${y})`,
  );
});

test('research: dates outside 2020-2030 are not touched', async () => {
  // Historical years must not be rewritten — "Bitcoin 2017 price"
  // is a legitimate historical query.
  const llm = llmWithPlan({
    queries: ['Bitcoin 2017 price', 'iPhone 2010 launch', 'RFC 2018 spec'],
  });
  const captured: string[] = [];
  const agent = createResearchAgent({
    llmProvider: llm,
    model: { provider: 'p', name: 'n' },
    searchProvider: async (q) => {
      captured.push(q);
      return [{ title: 'a', url: 'https://example.com' }];
    },
    fetchProvider: async () => 'x'.repeat(500),
    maxIterations: 1,
    maxPagesToFetch: 1,
    maxQueries: 3,
  });

  await agent.execute(mkCtx('historical'));
  assert.deepEqual(captured, [
    'Bitcoin 2017 price',
    'iPhone 2010 launch',
    'RFC 2018 spec',
  ], 'queries with years outside 2020-2030 should be left alone');
});

test('research: only the first 4-digit year token is replaced, not embedded digits', async () => {
  // Make sure we don't accidentally rewrite years inside other tokens
  // (e.g. "Product 2025 review" should still produce
  //  "Product <currentYear> review" — but "v20250901" should not be
  // touched because the regex requires a word boundary on both sides).
  const llm = llmWithPlan({
    queries: ['GLM 2025 pricing', 'release v20250901 notes'],
  });
  const captured: string[] = [];
  const agent = createResearchAgent({
    llmProvider: llm,
    model: { provider: 'p', name: 'n' },
    searchProvider: async (q) => {
      captured.push(q);
      return [{ title: 'a', url: 'https://example.com' }];
    },
    fetchProvider: async () => 'x'.repeat(500),
    maxIterations: 1,
    maxPagesToFetch: 1,
    maxQueries: 3,
  });

  await agent.execute(mkCtx('test'));
  const y = String(currentYear);
  assert.deepEqual(captured, [
    `GLM ${y} pricing`,
    'release v20250901 notes',
  ], 'word-boundary regex should not touch years inside version strings');
});

test('research: parse-error fallback preserves years in user task', async () => {
  // If the LLM returns non-JSON, the agent falls back to the
  // original user task as the sole query. We still run the
  // normaliser on it, but the task itself is whitelisted — so
  // years that appear in the user's own request are preserved.
  const llm: ILLMProvider = {
    name: 'stub',
    supportedModels: [],
    async generate(): Promise<LLMResponse> {
      return {
        message: { role: 'assistant', content: 'this is not JSON' },
        usage: { tokensIn: 0, tokensOut: 0 },
        durationMs: 0,
        finishReason: 'end_turn',
        costUsd: 0,
      };
    },
  };
  const captured: string[] = [];
  const agent = createResearchAgent({
    llmProvider: llm,
    model: { provider: 'p', name: 'n' },
    searchProvider: async (q) => {
      captured.push(q);
      return [{ title: 'a', url: 'https://example.com' }];
    },
    fetchProvider: async () => 'x'.repeat(500),
    maxIterations: 1,
    maxPagesToFetch: 1,
    maxQueries: 1,
  });

  await agent.execute(mkCtx('openai pricing 2025'));
  // 2025 is in the task → whitelisted → preserved verbatim.
  assert.equal(captured[0], 'openai pricing 2025',
    'parse-error fallback should preserve years in the user task via whitelist');
});

test('research: user-specified historical year is preserved (NOT rewritten)', async () => {
  // Regression: if the user asks for "查询 2023 年的数据" we must
  // not silently rewrite 2023 to the current year. Whitelist the
  // years that appear in the original task.
  const llm = llmWithPlan({
    queries: ['查询 2023 年报', '2023 财务数据', '2025 行业报告'],
  });
  const captured: string[] = [];
  const agent = createResearchAgent({
    llmProvider: llm,
    model: { provider: 'p', name: 'n' },
    searchProvider: async (q) => {
      captured.push(q);
      return [{ title: 'a', url: 'https://example.com' }];
    },
    fetchProvider: async () => 'x'.repeat(500),
    maxIterations: 1,
    maxPagesToFetch: 1,
    maxQueries: 3,
  });

  await agent.execute(mkCtx('查询 2023 年的数据'));
  const y = String(currentYear);
  // 2023 appears in the user task → it must be preserved.
  // 2025 does NOT appear in the user task → it must be rewritten
  // to the current year.
  assert.deepEqual(captured, [
    '查询 2023 年报',
    '2023 财务数据',
    `${y} 行业报告`,
  ], 'user-specified years must be preserved; only LLM-added years are rewritten');
});

test('research: user explicitly mentioning current year is also a no-op', async () => {
  // When the user *does* say the current year explicitly, the
  // whitelist still works and the LLM's echoed year is left alone.
  const y = String(currentYear);
  const llm = llmWithPlan({
    queries: [`GLM pricing ${y}`, 'GLM coding plan 2024'],
  });
  const captured: string[] = [];
  const agent = createResearchAgent({
    llmProvider: llm,
    model: { provider: 'p', name: 'n' },
    searchProvider: async (q) => {
      captured.push(q);
      return [{ title: 'a', url: 'https://example.com' }];
    },
    fetchProvider: async () => 'x'.repeat(500),
    maxIterations: 1,
    maxPagesToFetch: 1,
    maxQueries: 2,
  });

  await agent.execute(mkCtx(`帮我查 GLM ${y} 的定价`));
  // User mentioned <currentYear> → whitelist includes it.
  // The 2024 suffix wasn't mentioned by the user → rewritten to
  // the current year.
  assert.deepEqual(captured, [
    `GLM pricing ${y}`,
    `GLM coding plan ${y}`,
  ]);
});

test('research: multiple user-specified years are all preserved', async () => {
  // Comparison-style query where the user lists several years.
  // All of them must be kept verbatim.
  const llm = llmWithPlan({
    queries: ['AI 行业 2023 vs 2024 vs 2025 对比'],
  });
  const captured: string[] = [];
  const agent = createResearchAgent({
    llmProvider: llm,
    model: { provider: 'p', name: 'n' },
    searchProvider: async (q) => {
      captured.push(q);
      return [{ title: 'a', url: 'https://example.com' }];
    },
    fetchProvider: async () => 'x'.repeat(500),
    maxIterations: 1,
    maxPagesToFetch: 1,
    maxQueries: 1,
  });

  await agent.execute(mkCtx('AI 行业 2023 vs 2024 vs 2025 对比'));
  assert.deepEqual(captured, [
    'AI 行业 2023 vs 2024 vs 2025 对比',
  ], 'all user-specified years must be preserved');
});
