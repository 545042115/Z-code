// BenchmarkRunner — runs a Benchmark suite against a candidate agent.
//
// A `Benchmark` is a set of `Case`s. Each Case specifies:
//   - input to feed the candidate
//   - command to run (typically the candidate's CLI or a test fixture)
//   - rubric to score against
//
// The runner spawns a fresh sandbox per case, executes the candidate,
// records an `Evaluation` per case, and aggregates.
//
// ADR-0001: Harness sits behind a Docker sandbox in production. The
// contract is `SandboxExecutor` so swapping is trivial.

import type { Evaluation } from '../contracts';
import type { SandboxExecutor, SandboxSpec, SandboxResult } from './sandbox';
import { scoreSandboxResult, makeEvaluation, type RubricSpec } from './rubric';

export interface BenchmarkCaseSpec {
  id: string;
  /** Task description given to the agent (recorded on the suite). */
  prompt: string;
  /** Command to run inside the sandbox (the candidate). */
  command: string;
  args?: string[];
  /** Files/dirs to mount. */
  mounts?: SandboxSpec['mounts'];
  timeoutMs?: number;
  /** Rubric for this case. */
  rubric: RubricSpec;
  /** Repo for traceability (passed through to Evaluation.notes). */
  repo?: string;
}

export interface BenchmarkSuiteSpec {
  id: string;
  name: string;
  /** Suite version (for reproducibility). */
  version: string;
  cases: BenchmarkCaseSpec[];
  createdAt?: number;
}

export interface BenchmarkRunOptions {
  sandbox: SandboxExecutor;
  suite: BenchmarkSuiteSpec;
  /** Name of the candidate being evaluated; recorded in Evaluation. */
  candidate: string;
  /** Per-Run id (so all cases share the trace). */
  runId: string;
  /** Hook called after each case; useful for UI updates. */
  onCaseResult?: (e: Evaluation) => void;
  /** Hook called on case error; runner continues to next case. */
  onCaseError?: (caseId: string, e: Error) => void;
}

export interface BenchmarkRunSummary {
  benchmarkId: string;
  candidate: string;
  startedAt: number;
  finishedAt: number;
  caseCount: number;
  passedCount: number;
  failedCount: number;
  averageScore: number;
  evaluations: Evaluation[];
}

export class BenchmarkRunner {
  /**
   * Run the full suite. Returns a summary; never throws on case error
   * (records it as a failed Evaluation with score=0).
   */
  async run(opts: BenchmarkRunOptions): Promise<BenchmarkRunSummary> {
    const startedAt = Date.now();
    const evaluations: Evaluation[] = [];

    for (const c of opts.suite.cases) {
      try {
        const evalResult = await this.runCase(c, opts);
        evaluations.push(evalResult);
        opts.onCaseResult?.(evalResult);
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        // Failure case: produce a zero-score evaluation so the suite
        // report still contains it.
        const failed: Evaluation = makeEvaluation({
          id: `${c.id}-${opts.runId}-${Date.now()}`,
          benchmarkId: opts.suite.id,
          runId: opts.runId,
          candidate: opts.candidate,
          scores: {},
          total: 0,
          passed: false,
          notes: `[6001] ${err.message}`,
          startedAt: Date.now(),
          finishedAt: Date.now(),
        });
        evaluations.push(failed);
        opts.onCaseError?.(c.id, err);
      }
    }

    const finishedAt = Date.now();
    const passed = evaluations.filter((e) => e.pass).length;
    const avg = evaluations.length
      ? evaluations.reduce((s, e) => s + e.total, 0) / evaluations.length
      : 0;

    return {
      benchmarkId: opts.suite.id,
      candidate: opts.candidate,
      startedAt,
      finishedAt,
      caseCount: evaluations.length,
      passedCount: passed,
      failedCount: evaluations.length - passed,
      averageScore: avg,
      evaluations,
    };
  }

  // ── Per-case execution ─────────────────────────────────────────────

  private async runCase(c: BenchmarkCaseSpec, opts: BenchmarkRunOptions): Promise<Evaluation> {
    const spec: SandboxSpec = {
      runId: `${opts.runId}-${c.id}`,
      workdir: '/work',
      mounts: c.mounts,
      timeoutMs: c.timeoutMs,
    };
    const t0 = Date.now();
    const sandboxResult = await opts.sandbox.run(spec, c.command, c.args);
    const { total, scores, passed } = await scoreSandboxResult(sandboxResult, c.rubric);
    return makeEvaluation({
      id: `${c.id}-${opts.runId}-${Date.now()}`,
      benchmarkId: opts.suite.id,
      runId: opts.runId,
      candidate: opts.candidate,
      scores,
      total,
      passed,
      notes: sandboxResult.stdout.slice(-200),
      startedAt: t0,
      finishedAt: Date.now(),
    });
  }
}

// ── Convenience constructors ───────────────────────────────────────────

/** Build a one-off benchmark suite from a flat list. */
export function suiteFromCases(args: {
  id: string;
  name: string;
  version: string;
  cases: BenchmarkCaseSpec[];
}): BenchmarkSuiteSpec {
  return {
    id: args.id,
    name: args.name,
    version: args.version,
    createdAt: Date.now(),
    cases: args.cases,
  };
}
