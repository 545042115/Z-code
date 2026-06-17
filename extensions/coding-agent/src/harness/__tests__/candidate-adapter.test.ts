// Tests for CandidateAdapter (agent-in-sandbox).
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { CandidateAdapter } from '../candidate-adapter';
import { StubSandbox, type SandboxResult } from '../sandbox';
import { exitCodeZero, hasArtifact, type RubricSpec } from '../rubric';
import type { IAgent, TaskContext, AgentResult } from '../../contracts';
import { ok } from '../../contracts';

function mkResult(over: Partial<SandboxResult> = {}): SandboxResult {
  return {
    exitCode: 0, stdout: 'OK', stderr: '', durationMs: 50, timedOut: false,
    artifacts: ['result.json'], ...over,
  };
}

const stubAgent: IAgent = {
  name: 'stub', role: 'Stub', capabilities: [], dependencies: [],
  execute: async (_ctx: TaskContext): Promise<AgentResult> => ok({ x: 1 }),
};

const rubric: RubricSpec = {
  id: 'r', name: 'R', passThreshold: 50,
  weights: { exit: 0.5, artifact: 0.5 },
  checks: {
    exit: exitCodeZero,
    artifact: hasArtifact('result.json'),
  },
};

test('candidate: evaluate produces an Evaluation', async () => {
  const sandbox = new StubSandbox(mkResult());
  const adapter = new CandidateAdapter({ agent: stubAgent, sandbox });
  const e = await adapter.evaluate({
    runId: 'r1', task: 't', input: { x: 1 }, rubric, candidate: 'stub', timeoutMs: 1000,
  });
  assert.strictEqual(e.runId, 'r1');
  assert.strictEqual(e.total, 100);
  assert.strictEqual(e.pass, true);
});

test('candidate: mounts input.json into the sandbox', async () => {
  const sandbox = new StubSandbox(mkResult());
  const adapter = new CandidateAdapter({ agent: stubAgent, sandbox });
  await adapter.evaluate({
    runId: 'r1', task: 't', input: { foo: 'bar' }, rubric, candidate: 'stub', timeoutMs: 1000,
  });
  const mount = sandbox.lastSpec?.mounts?.[0];
  assert.ok(mount);
  assert.strictEqual(mount.dst, 'input.json');
  assert.strictEqual(mount.readonly, true);
});

test('candidate: offline network is set', async () => {
  const sandbox = new StubSandbox(mkResult());
  const adapter = new CandidateAdapter({ agent: stubAgent, sandbox });
  await adapter.evaluate({
    runId: 'r1', task: 't', input: null, rubric, candidate: 'stub', timeoutMs: 1000,
  });
  assert.strictEqual(sandbox.lastSpec?.network, 'offline');
});

test('candidate: half the checks pass → 50 total', async () => {
  const sandbox = new StubSandbox(mkResult({ exitCode: 1 }));
  const adapter = new CandidateAdapter({ agent: stubAgent, sandbox });
  const e = await adapter.evaluate({
    runId: 'r1', task: 't', input: null, rubric, candidate: 'stub',
  });
  assert.strictEqual(e.total, 50);
  assert.strictEqual(e.pass, true);   // 50 >= passThreshold 50
});
