// Tests for BenchmarkRunner (V2).
//
// Phase 6A: migrated from V1
// `extensions/coding-agent/src/harness/__tests__/benchmark-runner.test.ts`.
// Pure Node, no vscode.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { BenchmarkRunner, suiteFromCases } from '../benchmark-runner';
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

test('BenchmarkRunner: all-pass suite', async () => {
  const sandbox = new StubSandbox(passingResult);
  const suite = suiteFromCases({
    id: 's1', name: 'S', version: '1',
    cases: [
      { id: 'c1', prompt: 'p', command: 'echo', rubric },
      { id: 'c2', prompt: 'p', command: 'echo', rubric },
    ],
  });
  const r = new BenchmarkRunner();
  const summary = await r.run({ sandbox, suite, candidate: 'A', runId: 'r1' });
  assert.strictEqual(summary.caseCount, 2);
  assert.strictEqual(summary.passedCount, 2);
  assert.strictEqual(summary.failedCount, 0);
  assert.strictEqual(summary.averageScore, 100);
});

test('BenchmarkRunner: mixed pass/fail', async () => {
  const sandbox = new StubSandbox(passingResult);
  sandbox.setNext(passingResult);
  const suite = suiteFromCases({
    id: 's1', name: 'S', version: '1',
    cases: [
      { id: 'c1', prompt: 'p', command: 'echo', rubric },
      { id: 'c2', prompt: 'p', command: 'echo', rubric },
    ],
  });
  // First call: pass, second: fail
  let count = 0;
  const flaky = new StubSandbox(passingResult);
  const orig = flaky.run.bind(flaky);
  flaky.run = async (spec, cmd, args) => {
    count++;
    if (count === 2) return { ...failingResult };
    return orig(spec, cmd, args);
  };
  const r = new BenchmarkRunner();
  const summary = await r.run({ sandbox: flaky, suite, candidate: 'A', runId: 'r1' });
  assert.strictEqual(summary.caseCount, 2);
  assert.strictEqual(summary.passedCount, 1);
  assert.strictEqual(summary.failedCount, 1);
  assert.strictEqual(summary.averageScore, 50);
});

test('BenchmarkRunner: sandbox error → failed eval with score 0', async () => {
  const sandbox = new StubSandbox(passingResult);
  sandbox.run = async () => { throw new Error('boom'); };
  const suite = suiteFromCases({
    id: 's1', name: 'S', version: '1',
    cases: [{ id: 'c1', prompt: 'p', command: 'echo', rubric }],
  });
  const r = new BenchmarkRunner();
  const summary = await r.run({ sandbox, suite, candidate: 'A', runId: 'r1' });
  assert.strictEqual(summary.caseCount, 1);
  assert.strictEqual(summary.passedCount, 0);
  assert.strictEqual(summary.failedCount, 1);
  assert.ok(summary.evaluations[0].notes?.includes('6001'));
});

test('BenchmarkRunner: onCaseResult hook fires per case', async () => {
  const sandbox = new StubSandbox(passingResult);
  const suite = suiteFromCases({
    id: 's1', name: 'S', version: '1',
    cases: [
      { id: 'c1', prompt: 'p', command: 'echo', rubric },
      { id: 'c2', prompt: 'p', command: 'echo', rubric },
    ],
  });
  const seen: string[] = [];
  const r = new BenchmarkRunner();
  await r.run({
    sandbox, suite, candidate: 'A', runId: 'r1',
    onCaseResult: (e) => seen.push(e.runId),
  });
  assert.deepStrictEqual(seen, ['r1', 'r1']);
});

test('BenchmarkRunner: onCaseError hook fires on sandbox error', async () => {
  const sandbox = new StubSandbox(passingResult);
  sandbox.run = async () => { throw new Error('boom'); };
  const suite = suiteFromCases({
    id: 's1', name: 'S', version: '1',
    cases: [{ id: 'c1', prompt: 'p', command: 'echo', rubric }],
  });
  const seen: string[] = [];
  const r = new BenchmarkRunner();
  await r.run({
    sandbox, suite, candidate: 'A', runId: 'r1',
    onCaseError: (id) => seen.push(id),
  });
  assert.deepStrictEqual(seen, ['c1']);
});
