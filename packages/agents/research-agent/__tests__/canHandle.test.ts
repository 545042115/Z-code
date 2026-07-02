// Tests for the Research Agent's canHandle scoring logic.
//
// The router uses keyword matching + embedding similarity to pick an
// agent. The previous keyword set missed common Chinese look-up and
// pricing/comparison intents, which caused pricing queries like
// "查询 GLM/火山方舟 coding plan 费用" to be routed to the coding
// agent. These tests pin the new behaviour so a regression is caught
// immediately.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { ResearchAgent } from '../src';
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

const agent = new ResearchAgent({
  llmProvider: {
    name: 'stub',
    supportedModels: [],
    generate: async () => ({
      message: { role: 'assistant', content: '{"queries":[]}' },
      usage: { tokensIn: 0, tokensOut: 0 },
      durationMs: 0,
      finishReason: 'end_turn',
      costUsd: 0,
    }),
  },
  model: { provider: 'p', name: 'n' },
  searchProvider: async () => [],
  fetchProvider: async () => '',
});

test('research: Chinese lookup intent scores above base', () => {
  const score = agent.canHandle(mkCtx('帮我查询一下国内LLM厂商费用'));
  assert.ok(score >= 0.65, `expected >= 0.65, got ${score}`);
});

test('research: original pricing query (GLM/火山方舟) scores high', () => {
  // This is the exact query the user reported being misrouted to coding.
  // With the new keyword set, it should comfortably exceed the coding
  // agent's 0.2 default + signal boosts.
  const score = agent.canHandle(
    mkCtx('帮我查询一下国内各大LLM厂商/服务提供商如GLM/火山方舟的coding plan/token plan费用，哪些比较划算一些'),
  );
  assert.ok(score >= 0.85, `expected >= 0.85, got ${score}`);
});

test('research: pricing keywords (费用/价格/划算) score well', () => {
  for (const task of [
    '华为云服务器价格',
    'AWS和Azure对比',
    '哪个云服务商的套餐更划算',
    'find the best price for LLM tokens',
    'compare pricing for coding plan',
  ]) {
    const score = agent.canHandle(mkCtx(task));
    assert.ok(score >= 0.6, `"${task}" expected >= 0.6, got ${score}`);
  }
});

test('research: lookup phrases (查询/查一下/有哪些) score well', () => {
  for (const task of [
    '查询一下今天北京天气',
    '查一下最新的GPT模型',
    '有哪些免费的图标素材网站',
    '哪家外卖平台便宜',
  ]) {
    const score = agent.canHandle(mkCtx(task));
    assert.ok(score >= 0.6, `"${task}" expected >= 0.6, got ${score}`);
  }
});

test('research: scores within [0, 0.95] cap', () => {
  const score = agent.canHandle(
    mkCtx('调研 研究 综述 调查 分析 搜索 查找 收集资料 查找资料 查询 查一下 查一查 了解 看看 有哪些 哪家 哪个 怎么 如何 怎么样 价格 费用 多少钱 划算 便宜 套餐 比价 比较 对比 汇总 排行 推荐 优惠 折扣 报告 总结 概述'),
  );
  assert.ok(score <= 0.95, `expected <= 0.95, got ${score}`);
});

test('research: weak research signal still beats coding default 0.2', () => {
  // A single weak Chinese lookup word should push research above 0.2
  // so the router doesn't fall back to the coding agent.
  const score = agent.canHandle(mkCtx('看看今天的新闻'));
  assert.ok(score >= 0.5, `expected >= 0.5 (research should beat coding's 0.2), got ${score}`);
});

test('research: bare "plan" in commercial context still scores high', () => {
  // "GLM coding plan" alone (no other signals) should still trigger
  // research because the commercial-plan context gives a 0.55 floor.
  const score = agent.canHandle(mkCtx('GLM coding plan'));
  assert.ok(score >= 0.55, `expected >= 0.55, got ${score}`);
});

test('research: empty task returns base 0.45', () => {
  const score = agent.canHandle(mkCtx(''));
  assert.strictEqual(score, 0.45);
});

test('research: case-insensitive matching', () => {
  const score = agent.canHandle(mkCtx('RESEARCH THE LATEST LLM PRICING'));
  assert.ok(score >= 0.65, `expected >= 0.65, got ${score}`);
});
