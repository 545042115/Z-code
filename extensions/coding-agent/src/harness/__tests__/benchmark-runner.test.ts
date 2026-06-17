// Tests for BenchmarkRunner + Sandbox adapters.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { StubSandbox, type SandboxResult } from '../sandbox';
import { BenchmarkRunner, suiteFromCases, type BenchmarkSuiteSpec } from '../benchmark-runner';
import { exitCodeZero, hasArtifact, type RubricSpec } from '../rubric';

function mkResult(over: Partial<SandboxResult> = {}): SandboxResult {
  return {
    exitCode: 0, stdout: 'OK', stderr: '', durationMs: 50, timedOut: false,
    artifacts: ['result.json'], ...over,
  };
}

const r1: RubricSpec = { id: 'r1', name: 'R1', passThreshold: 50, weights: { a: 1 }, checks: { a: exitCodeZero } };
const r2: RubricSpec = { id: 'r2', name: 'R2', passThreshold: 100, weights: { a: 1 }, checks: { a: hasArtifact('result.json') } };

test('runner: runs all cases and aggregates', async () => {
  const sandbox = new StubSandbox(mkResult());
  const suite: BenchmarkSuiteSpec = suiteFromCases({
    id: 'b1', name: 'B1', version: '1',
    cases: [
      { id: 'c1', prompt: 'x', command: 'node', rubric: r1 },
      { id: 'c2', prompt: 'y', command: 'node', rubric: r2 },
    ],
  });
  const r = new BenchmarkRunner();
  const out = await r.run({ sandbox, suite, candidate: 'test', runId: 'r1' });
  assert.strictEqual(out.caseCount, 2);
  assert.strictEqual(out.passedCount, 2);
  assert.strictEqual(out.failedCount, 0);
  assert.strictEqual(out.averageScore, 100);
});

test('runner: failing case gets total 0 but suite continues', async () => {
  const sandbox = new StubSandbox(mkResult({ exitCode: 1 }));
  const suite: BenchmarkSuiteSpec = suiteFromCases({
    id: 'b1', name: 'B1', version: '1',
    cases: [
      { id: 'c1', prompt: '', command: 'x', rubric: r1 },
      { id: 'c2', prompt: '', command: 'x', rubric: r1 },
    ],
  });
  const r = new BenchmarkRunner();
  const out = await r.run({ sandbox, suite, candidate: 't', runId: 'r1' });
  assert.strictEqual(out.failedCount, 2);
  assert.strictEqual(out.averageScore, 0);
});

test('runner: sandbox error records notes "[6001]..." and continues', async () => {
  let callIdx = 0;
  const sandbox = new StubSandbox(mkResult());
  const oldRun = sandbox.run.bind(sandbox);
  sandbox.run = async (spec, cmd, args) => {
    callIdx++;
    if (callIdx === 1) throw new Error('sandbox exploded');
    return oldRun(spec, cmd, args);
  };
  const suite: BenchmarkSuiteSpec = suiteFromCases({
    id: 'b1', name: 'B1', version: '1',
    cases: [
      { id: 'c1', prompt: '', command: 'x', rubric: r1 },
      { id: 'c2', prompt: '', command: 'x', rubric: r1 },
    ],
  });
  let erroredCase: string | null = null;
  const r = new BenchmarkRunner();
  const out = await r.run({
    sandbox, suite, candidate: 't', runId: 'r1',
    onCaseError: (id) => { erroredCase = id; },
  });
  assert.strictEqual(erroredCase, 'c1');
  assert.strictEqual(out.evaluations[0].total, 0);
  assert.ok(out.evaluations[0].notes?.includes('[6001]'));
  assert.strictEqual(out.evaluations[1].total, 100);   // c2 still ran
});

test('runner: onCaseResult fires per case', async () => {
  const sandbox = new StubSandbox(mkResult());
  const suite: BenchmarkSuiteSpec = suiteFromCases({
    id: 'b1', name: 'B1', version: '1',
    cases: [
      { id: 'c1', prompt: '', command: 'x', rubric: r1 },
      { id: 'c2', prompt: '', command: 'x', rubric: r1 },
    ],
  });
  let count = 0;
  const r = new BenchmarkRunner();
  await r.run({
    sandbox, suite, candidate: 't', runId: 'r1',
    onCaseResult: () => { count++; },
  });
  assert.strictEqual(count, 2);
});

test('runner: stub captures the spec, command, args', async () => {
  const sandbox = new StubSandbox(mkResult());
  const suite: BenchmarkSuiteSpec = suiteFromCases({
    id: 'b1', name: 'B1', version: '1',
    cases: [
      { id: 'c1', prompt: '', command: 'pytest', args: ['-v'], rubric: r1 },
    ],
  });
  const r = new BenchmarkRunner();
  await r.run({ sandbox, suite, candidate: 't', runId: 'r1' });
  assert.strictEqual(sandbox.lastCmd, 'pytest');
  assert.deepStrictEqual(sandbox.lastArgs, ['-v']);
  assert.strictEqual(sandbox.lastSpec?.runId, 'r1-c1');
});

test('runner: empty suite produces 0 average', async () => {
  const sandbox = new StubSandbox(mkResult());
  const suite: BenchmarkSuiteSpec = suiteFromCases({
    id: 'b1', name: 'B1', version: '1', cases: [],
  });
  const r = new BenchmarkRunner();
  const out = await r.run({ sandbox, suite, candidate: 't', runId: 'r1' });
  assert.strictEqual(out.caseCount, 0);
  assert.strictEqual(out.averageScore, 0);
});

test('suiteFromCases: builds a Benchmark with timestamps', () => {
  const s = suiteFromCases({
    id: 'b', name: 'B', version: '1', cases: [],
  });
  assert.strictEqual(s.id, 'b');
  assert.ok((s.createdAt ?? 0) > 0);
  assert.deepStrictEqual(s.cases, []);
});
