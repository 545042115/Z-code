// @z-assistant/runtime — workflow engine tests

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { runWorkflow, type WorkflowDefinition, type WorkflowContext, type ToolWorkflowStep } from '../workflow';

function emptyCtx(inputs: Record<string, unknown> = {}): WorkflowContext {
  return { inputs, outputs: {}, variables: {} };
}

describe('runWorkflow', () => {
  it('runs sequential tool steps', async () => {
    const def: WorkflowDefinition = {
      name: 'seq',
      steps: [
        { id: 's1', tool: 'echo', args: { msg: 'a' } },
        { id: 's2', tool: 'echo', args: { msg: 'b' } },
      ],
    };
    const results: string[] = [];
    const result = await runWorkflow(def, emptyCtx(), async (step) => {
      const toolStep = step as ToolWorkflowStep;
      results.push(String(toolStep.args.msg));
      return toolStep.args.msg;
    });
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(results, ['a', 'b']);
  });

  it('respects dependencies', async () => {
    const def: WorkflowDefinition = {
      name: 'deps',
      steps: [
        { id: 's1', tool: 'echo', args: { msg: 'a' } },
        { id: 's2', tool: 'echo', args: { msg: 'b' }, dependsOn: ['s1'] },
        { id: 's3', tool: 'echo', args: { msg: 'c' }, dependsOn: ['s1'] },
      ],
    };
    const result = await runWorkflow(def, emptyCtx(), async () => 'done');
    assert.strictEqual(result.ok, true);
  });

  it('renders templated args from inputs', async () => {
    const def: WorkflowDefinition = {
      name: 'template',
      steps: [
        { id: 's1', tool: 'echo', args: { msg: '{{ inputs.name }}' } },
      ],
    };
    const result = await runWorkflow(def, emptyCtx({ name: 'Alice' }), async (step) => (step as ToolWorkflowStep).args.msg);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.stepResults.s1, 'Alice');
  });

  it('renders templated args from previous outputs', async () => {
    const def: WorkflowDefinition = {
      name: 'chain',
      steps: [
        { id: 's1', tool: 'echo', args: { msg: 'hello' } },
        { id: 's2', tool: 'echo', args: { msg: '{{ outputs.s1 }} world' }, dependsOn: ['s1'] },
      ],
    };
    const result = await runWorkflow(def, emptyCtx(), async (step) => (step as ToolWorkflowStep).args.msg);
    assert.strictEqual(result.stepResults.s2, 'hello world');
  });

  it('skips steps when condition is false', async () => {
    const def: WorkflowDefinition = {
      name: 'conditional',
      steps: [
        { id: 's1', tool: 'echo', args: { msg: 'a' }, if: '{{ inputs.run }}' },
      ],
    };
    const result = await runWorkflow(def, emptyCtx({ run: false }), async () => 'done');
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.stepResults.s1, { skipped: true });
  });

  it('fails on missing dependency', async () => {
    const def: WorkflowDefinition = {
      name: 'bad',
      steps: [
        { id: 's1', tool: 'echo', args: {}, dependsOn: ['missing'] },
      ],
    };
    const result = await runWorkflow(def, emptyCtx(), async () => 'done');
    assert.strictEqual(result.ok, false);
    assert.ok(result.error?.includes('Unknown'));
  });

  it('fails when executor throws', async () => {
    const def: WorkflowDefinition = {
      name: 'err',
      steps: [
        { id: 's1', tool: 'echo', args: {} },
      ],
    };
    const result = await runWorkflow(def, emptyCtx(), async () => { throw new Error('boom'); });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.failedStepId, 's1');
  });

  it('detects dependency cycles', async () => {
    const def: WorkflowDefinition = {
      name: 'cycle',
      steps: [
        { id: 's1', tool: 'echo', args: {}, dependsOn: ['s2'] },
        { id: 's2', tool: 'echo', args: {}, dependsOn: ['s1'] },
      ],
    };
    const result = await runWorkflow(def, emptyCtx(), async () => 'done');
    assert.strictEqual(result.ok, false);
    assert.ok(result.error?.includes('cycle'));
  });
});
