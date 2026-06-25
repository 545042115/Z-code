// Tests for the Planner Agent's system prompt.
//
// The planner's prompt encodes the architectural rule: every sub-task
// goes to exactly one worker agent, and complex goals are decomposed
// further. These tests pin the wording so a regression is caught
// immediately when the prompt changes.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createPlannerAgent } from '../src';
import type { ILLMProvider, LLMMessage, LLMResponse, TaskContext } from '@z-assistant/contracts';

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

function mkLLM(captured: { system?: string; user?: string }): ILLMProvider {
  return {
    name: 'stub',
    supportedModels: [],
    async generate(req): Promise<LLMResponse> {
      for (const m of req.messages) {
        if (m.role === 'system') captured.system = m.content;
        if (m.role === 'user') captured.user = m.content;
      }
      // Return a single atomic sub-task.
      return {
        message: {
          role: 'assistant',
          content: JSON.stringify({
            rationale: 'Atomic task',
            subtasks: [{ id: 'only', title: 'Only step', prompt: '...', assignedTo: 'chat', dependsOn: [] }],
          }),
        },
        usage: { tokensIn: 0, tokensOut: 0 },
        durationMs: 0,
        finishReason: 'end_turn',
        costUsd: 0,
      };
    },
  };
}

test('planner: prompt enforces one-agent-per-subtask', async () => {
  const captured: { system?: string; user?: string } = {};
  const agent = createPlannerAgent({ llmProvider: mkLLM(captured), model: { provider: 'p', name: 'n' } });
  await agent.execute(mkCtx('查询 GLM 定价'));
  assert.ok(captured.system, 'system prompt should be captured');
  assert.match(
    captured.system!,
    /One sub-task = ONE worker agent/,
    'planner prompt must explicitly state one-agent-per-subtask',
  );
});

test('planner: prompt forbids multi-agent collaboration on a sub-task', async () => {
  const captured: { system?: string; user?: string } = {};
  const agent = createPlannerAgent({ llmProvider: mkLLM(captured), model: { provider: 'p', name: 'n' } });
  await agent.execute(mkCtx('查询并写代码'));
  assert.match(
    captured.system!,
    /No multi-agent collaboration/i,
    'planner prompt must forbid multi-agent collaboration on a single sub-task',
  );
});

test('planner: prompt tells the planner to decompose further when complex', async () => {
  const captured: { system?: string; user?: string } = {};
  const agent = createPlannerAgent({ llmProvider: mkLLM(captured), model: { provider: 'p', name: 'n' } });
  await agent.execute(mkCtx('Build a website'));
  assert.match(
    captured.system!,
    /[Dd]ecompose further|too complex|smaller sub-tasks/,
    'planner prompt must instruct decomposition of complex sub-tasks',
  );
});

test('planner: prompt lists the browser agent with capability hints', async () => {
  const captured: { system?: string; user?: string } = {};
  const agent = createPlannerAgent({ llmProvider: mkLLM(captured), model: { provider: 'p', name: 'n' } });
  await agent.execute(mkCtx('Anything'));
  assert.match(
    captured.system!,
    /browser\s+—\s+interactive web pages/i,
    'planner prompt should describe the browser agent',
  );
  assert.match(
    captured.system!,
    /pricing/i,
    'planner prompt should mention pricing pages (so the model picks browser for them)',
  );
});

test('planner: prompt forbids assigning to self', async () => {
  const captured: { system?: string; user?: string } = {};
  const agent = createPlannerAgent({ llmProvider: mkLLM(captured), model: { provider: 'p', name: 'n' } });
  await agent.execute(mkCtx('Anything'));
  assert.match(
    captured.system!,
    /NEVER assign a sub-task to yourself/,
    'planner prompt must forbid self-assignment',
  );
});

test('planner: {max} placeholder is replaced with a number', async () => {
  const captured: { system?: string; user?: string } = {};
  const agent = createPlannerAgent({
    llmProvider: mkLLM(captured),
    model: { provider: 'p', name: 'n' },
    maxSubTasks: 7,
  });
  await agent.execute(mkCtx('Anything'));
  assert.ok(captured.system);
  assert.doesNotMatch(captured.system!, /\{max\}/, '{max} placeholder should be replaced');
  assert.match(captured.system!, /\b7\b/, 'replacement should contain the number 7');
});

test('planner: includes a worked example for the GLM/Volcano pricing query', async () => {
  const captured: { system?: string; user?: string } = {};
  const agent = createPlannerAgent({ llmProvider: mkLLM(captured), model: { provider: 'p', name: 'n' } });
  await agent.execute(mkCtx('Anything'));
  assert.ok(captured.system);
  assert.match(
    captured.system!,
    /open\.bigmodel\.cn\/pricing/,
    'planner prompt should include the GLM pricing example so the model learns the pattern',
  );
  assert.match(
    captured.system!,
    /volcengine\.com/,
    'planner prompt should include the Volcano example',
  );
});
