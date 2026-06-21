// @z-assistant/runtime — hierarchical planner tests

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  buildHierarchicalPlan,
  executeHierarchicalPlan,
  renderPlan,
  selectPlanningMode,
} from '../hierarchical-planner';
import type { ILLMProvider, TaskContext } from '@z-assistant/contracts';
import { SharedState } from '../../orchestrator/shared-state';

function fakeProvider(responseContent: string): ILLMProvider {
  return {
    name: 'fake',
    supportedModels: [{ provider: 'fake', name: 'fake' }],
    generate: async () => ({
      message: { role: 'assistant', content: responseContent },
      usage: { tokensIn: 10, tokensOut: 20 },
      finishReason: 'stop',
    }),
  } as unknown as ILLMProvider;
}

describe('selectPlanningMode', () => {
  it('selects hierarchical for explicit mode', () => {
    assert.strictEqual(selectPlanningMode('hello', 'hierarchical'), 'hierarchical');
  });

  it('selects simple for explicit mode', () => {
    assert.strictEqual(selectPlanningMode('plan something', 'simple'), 'simple');
  });

  it('auto picks hierarchical for plan keyword', () => {
    assert.strictEqual(selectPlanningMode('make a plan for my trip'), 'hierarchical');
  });

  it('auto picks hierarchical for long task', () => {
    const task = 'a'.repeat(100);
    assert.strictEqual(selectPlanningMode(task), 'hierarchical');
  });

  it('auto picks simple for short question', () => {
    assert.strictEqual(selectPlanningMode('hi'), 'simple');
  });
});

describe('buildHierarchicalPlan', () => {
  it('parses a valid LLM JSON plan', async () => {
    const response = JSON.stringify({
      milestones: [{ id: 'm1', name: 'Research', objective: 'Find hotels' }],
      steps: [{ id: 's1', milestoneId: 'm1', name: 'Search web', instruction: 'Search for hotels in Tokyo', dependsOn: [] }],
    });
    const plan = await buildHierarchicalPlan('plan a Tokyo trip', { llmProvider: fakeProvider(response) });
    assert.strictEqual(plan.milestones.length, 1);
    assert.strictEqual(plan.steps.length, 1);
    assert.strictEqual(plan.milestones[0].stepIds[0], 's1');
  });

  it('falls back to single-step plan on invalid JSON', async () => {
    const plan = await buildHierarchicalPlan('do something', { llmProvider: fakeProvider('not json') });
    assert.strictEqual(plan.steps.length, 1);
    assert.ok(plan.steps[0].description?.includes('do something'));
  });

  it('falls back when LLM throws', async () => {
    const provider = {
      generate: async () => { throw new Error('timeout'); },
    } as unknown as ILLMProvider;
    const plan = await buildHierarchicalPlan('do something', { llmProvider: provider });
    assert.strictEqual(plan.steps.length, 1);
  });
});

describe('executeHierarchicalPlan', () => {
  it('runs steps sequentially and stops on error', async () => {
    const plan = {
      id: 'p1',
      name: 'Test Plan',
      milestones: [{ id: 'm1', name: 'M', objective: 'O', stepIds: ['s1', 's2'] }],
      steps: [
        { id: 's1', name: 'ok', description: 'first', status: 'pending' as const },
        { id: 's2', name: 'fail', description: 'second', dependsOn: ['s1'], status: 'pending' as const },
      ],
    };
    const state = new SharedState({});
    const ctx: TaskContext = {
      task: 'test',
      model: { provider: 'fake', name: 'fake' },
      sessionId: 's1',
      sharedState: state,
      parentRunId: 'run-1',
      traceId: 'trace-1',
      budget: { tokensLeft: 10000, costLeftUsd: 1 },
    };
    const result = await executeHierarchicalPlan(plan, ctx, async (step) => {
      if (step.name === 'fail') throw new Error('boom');
      return 'done';
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.steps[0].status, 'ok');
    assert.strictEqual(result.steps[1].status, 'error');
  });
});

describe('renderPlan', () => {
  it('renders milestones and steps as markdown', () => {
    const plan = {
      id: 'p1',
      name: 'Test Plan',
      milestones: [{ id: 'm1', name: 'M', objective: 'O', stepIds: ['s1'] }],
      steps: [{ id: 's1', name: 'Step', description: 'Do it', status: 'pending' as const }],
    };
    const md = renderPlan(plan);
    assert.ok(md.includes('## Plan'));
    assert.ok(md.includes('### M'));
    assert.ok(md.includes('- [ ] Step: Do it'));
  });
});
