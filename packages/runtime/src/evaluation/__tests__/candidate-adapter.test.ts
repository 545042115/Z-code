// Tests for CandidateAdapter (V2).
//
// Phase 6A: migrated from V1
// `extensions/coding-agent/src/harness/__tests__/candidate-adapter.test.ts`.
// Pure Node, no vscode.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { CandidateAdapter } from '../candidate-adapter';
import { StubSandbox } from '../sandbox';
import type { SandboxResult } from '../sandbox';
import type { RubricSpec } from '../rubric';
import { exitCodeZero } from '../rubric';

const rubric: RubricSpec = {
  id: 'r', name: 'R', passThreshold: 1,
  weights: { ok: 1 }, checks: { ok: exitCodeZero },
};

const passingResult: SandboxResult = {
  exitCode: 0, stdout: 'OK', stderr: '', durationMs: 10, timedOut: false,
  artifacts: ['result.json'],
};

const failingResult: SandboxResult = {
  exitCode: 1, stdout: '', stderr: 'fail', durationMs: 10, timedOut: false,
  artifacts: [],
};

// Minimal fake IAgent
function mkAgent() {
  return {
    name: 'fake',
    role: 'fake',
    capabilities: [],
    dependencies: [],
    execute: async () => ({ ok: true, output: null }),
  };
}

test('CandidateAdapter: pass returns score 100', async () => {
  const sandbox = new StubSandbox(passingResult);
  const adapter = new CandidateAdapter({ agent: mkAgent() as never, sandbox });
  const ev = await adapter.evaluate({
    runId: 'r1', task: 't', input: { x: 1 }, rubric, candidate: 'A',
  });
  assert.strictEqual(ev.pass, true);
  assert.strictEqual(ev.total, 100);
});

test('CandidateAdapter: fail returns score 0', async () => {
  const sandbox = new StubSandbox(failingResult);
  const adapter = new CandidateAdapter({ agent: mkAgent() as never, sandbox });
  const ev = await adapter.evaluate({
    runId: 'r1', task: 't', input: { x: 1 }, rubric, candidate: 'A',
  });
  assert.strictEqual(ev.pass, false);
  assert.strictEqual(ev.total, 0);
});

test('CandidateAdapter: sandbox never throws on result', async () => {
  const sandbox = new StubSandbox(passingResult);
  const adapter = new CandidateAdapter({ agent: mkAgent() as never, sandbox });
  // Should not throw
  const ev = await adapter.evaluate({
    runId: 'r1', task: 't', input: null, rubric, candidate: 'A',
  });
  assert.ok(ev.id);
});
