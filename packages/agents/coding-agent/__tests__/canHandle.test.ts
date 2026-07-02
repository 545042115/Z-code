// Tests for the Coding Agent's canHandle scoring logic.
//
// The previous implementation returned a flat 0.5 for everything,
// which made it outrank the research agent on any task where research
// keywords didn't match. The new logic returns 0.2 by default and
// only boosts when explicit coding signals are present. These tests
// pin that behaviour.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { CodingAgent } from '../src/agent-core';
import type { TaskContext } from '@ziner/contracts';

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
    },
    parentRunId: 'r1',
    traceId: 't1',
    budget: { tokensLeft: 1_000_000, costLeftUsd: 1.0 },
  };
}

async function score(agent: CodingAgent, task: string): Promise<number> {
  const s = await agent.canHandle(mkCtx(task));
  return s;
}

test('coding: pricing query does NOT get boosted by "coding plan" token', async () => {
  // The exact query that was misrouted — "coding plan" is a product
  // name, not a coding task, so the commercial-plan stripper should
  // prevent the score from rising.
  const a = new CodingAgent();
  const s = await score(
    a,
    '帮我查询一下国内各大LLM厂商/服务提供商如GLM/火山方舟的coding plan/token plan费用，哪些比较划算一些',
  );
  // Default 0.2 only. The "coding plan" tokens are stripped, no other
  // coding signals present.
  assert.ok(s <= 0.25, `expected <= 0.25 (commercial-plan context), got ${s}`);
});

test('coding: default is 0.2 (no signals)', async () => {
  const a = new CodingAgent();
  const s = await score(a, 'hello world');
  assert.strictEqual(s, 0.2);
});

test('coding: explicit coding verb boosts score', async () => {
  const a = new CodingAgent();
  const s = await score(a, '帮我写一个 TypeScript 函数实现二分查找');
  assert.ok(s >= 0.45, `expected >= 0.45 (强编码信号), got ${s}`);
});

test('coding: "fix the bug" is a strong coding signal', async () => {
  const a = new CodingAgent();
  const s = await score(a, 'fix the bug in login flow');
  assert.ok(s >= 0.45, `expected >= 0.45, got ${s}`);
});

test('coding: language name alone gives small boost', async () => {
  const a = new CodingAgent();
  const s = await score(a, '用 TypeScript 重构这段代码');
  // 代码 (medium) + typescript (medium) + 重构 (strong) → expect a
  // comfortable boost over the 0.2 base.
  assert.ok(s >= 0.5, `expected >= 0.5, got ${s}`);
});

test('coding: pure English coding request scores high', async () => {
  const a = new CodingAgent();
  const s = await score(a, 'implement a regex parser for email addresses in TypeScript');
  assert.ok(s >= 0.55, `expected >= 0.55, got ${s}`);
});

test('coding: score is capped at 0.9', async () => {
  const a = new CodingAgent();
  const s = await score(
    a,
    '写代码 写函数 改代码 改bug 修bug 调试 重构 实现 编码 编译 跑测试 跑用例 单元测试 fix bug refactor implement debug compile unit test typescript python rust',
  );
  assert.ok(s <= 0.9, `expected <= 0.9, got ${s}`);
});
