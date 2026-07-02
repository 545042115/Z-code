// @ziner/runtime — BenchmarksService
//
// The orchestration layer for running benchmark suites. Wraps
// CodeTaskRunner, persists Evaluations to the agent-store, and
// optionally feeds the EvolutionEngine with failed cases for
// human-approved skill extraction.
//
// Lifecycle for `runSuite(suiteId)`:
//   1. Resolve suite → list of GitRepoFixture cases
//   2. For each case, sequentially:
//        a. CodeTaskRunner.run(case) → CodeTaskRunResult
//        b. Persist Evaluation to the agent store
//        c. Emit 'benchmark.caseCompleted' event
//        d. If failed and EvolutionEngine is wired, queue a
//           FailureFingerprint for the next evolution tick
//   3. Emit 'benchmark.suiteCompleted' with the summary
//
// Failures in one case do NOT abort the suite. The summary aggregates
// pass / fail / mean score / p50 latency.

import { randomUUID } from 'crypto';
import type { Store } from '@ziner/infra-storage';
import type { TraceManager } from '@ziner/trace';
import type { Evaluation } from '@ziner/contracts';
import {
  CodeTaskRunner,
  type CodeTaskRunResult,
  type GitRepoFixture,
} from './code-task-runner';
import { DockerSandbox, type DockerSandboxOptions } from './docker-sandbox';
import type { SandboxExecutor } from './sandbox';
import { BUILTIN_FIXTURES } from './fixtures';

export type BenchmarkEvent =
  | { type: 'benchmark.caseStarted'; suiteId: string; caseId: string; fixture: GitRepoFixture }
  | { type: 'benchmark.caseCompleted'; suiteId: string; caseId: string; result: CodeTaskRunResult }
  | { type: 'benchmark.suiteCompleted'; suiteId: string; summary: BenchmarkSuiteSummary };

export interface BenchmarkSuiteSummary {
  suiteId: string;
  startedAt: number;
  finishedAt: number;
  totalCases: number;
  passedCases: number;
  failedCases: number;
  meanScore: number;
  totalDurationMs: number;
  evaluations: Evaluation[];
}

export interface BenchmarkSuiteSpec {
  id: string;
  name: string;
  cases: GitRepoFixture[];
}

export interface BenchmarksServiceOptions {
  store?: Store;
  trace?: TraceManager;
  /** Sandbox executor. Default: new DockerSandbox(). */
  sandbox?: SandboxExecutor;
  /** Optional EvolutionEngine handle. When set, failed cases are
   *  surfaced as FailureFingerprints for the next evolution tick. */
  evolutionHook?: (fingerprint: {
    runId: string;
    task: string;
    agent: string;
    errorCode: string;
    errorMessage: string;
    timestamp: number;
  }) => void;
  /** Listener for benchmark.* events. */
  onEvent?: (e: BenchmarkEvent) => void;
}

export class BenchmarksService {
  private readonly store?: Store;
  private readonly trace?: TraceManager;
  private readonly sandbox: SandboxExecutor;
  private readonly evolutionHook?: BenchmarksServiceOptions['evolutionHook'];
  private readonly onEvent?: (e: BenchmarkEvent) => void;

  constructor(opts: BenchmarksServiceOptions = {}) {
    this.store = opts.store;
    this.trace = opts.trace;
    this.sandbox = opts.sandbox ?? new DockerSandbox();
    this.evolutionHook = opts.evolutionHook;
    this.onEvent = opts.onEvent;
  }

  /** Healthcheck the underlying sandbox. Returns `{ ok, version? }`. */
  async checkDocker(opts?: DockerSandboxOptions): Promise<{ ok: true; version: string } | { ok: false; reason: string }> {
    try {
      // If a custom sandbox is supplied we can't ping; assume ok.
      if (!(this.sandbox instanceof DockerSandbox)) {
        return { ok: true, version: 'custom' };
      }
      return await this.sandbox.ping();
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
  }

  /** All built-in suites. */
  listBuiltinSuites(): BenchmarkSuiteSpec[] {
    return [
      {
        id: 'builtin',
        name: 'Built-in: Flask / Express / jsoncpp',
        cases: BUILTIN_FIXTURES,
      },
    ];
  }

  /**
   * Run a single suite (sequentially). Emits events as cases complete.
   * Returns a summary including all Evaluations.
   */
  async runSuite(suiteId: string, options?: { cases?: GitRepoFixture[] }): Promise<BenchmarkSuiteSummary> {
    const suite = this.listBuiltinSuites().find((s) => s.id === suiteId);
    const cases = options?.cases ?? suite?.cases;
    if (!cases || cases.length === 0) {
      throw new Error(`Unknown suite: ${suiteId}`);
    }
    const runId = `bench-${randomUUID()}`;
    const t0 = Date.now();
    const runner = new CodeTaskRunner(this.sandbox);
    const evaluations: Evaluation[] = [];
    let passed = 0;
    let failed = 0;
    let scoreSum = 0;

    for (const fx of cases) {
      const caseId = fx.id;
      this.onEvent?.({ type: 'benchmark.caseStarted', suiteId, caseId, fixture: fx });
      try {
        const result = await runner.run({ runId, caseId, fixture: fx });
        evaluations.push(result.evaluation);
        scoreSum += result.evaluation.total;
        if (result.evaluation.pass) {
          passed += 1;
        } else {
          failed += 1;
          this.emitFailure(runId, fx, result);
        }
        this.onEvent?.({ type: 'benchmark.caseCompleted', suiteId, caseId, result });
        // Persist Evaluation to the agent store (best-effort)
        if (this.store) {
          try {
            await this.store.evals.insert(result.evaluation);
          } catch { /* ignore storage failures */ }
        }
      } catch (e) {
        // The runner itself threw (network, docker, etc.) — record
        // a synthetic failed Evaluation so the summary is complete.
        failed += 1;
        const evaluation: Evaluation = {
          id: `${runId}-${caseId}`,
          benchmarkId: fx.id,
          runId,
          scores: { patchApplied: 0, testsPassed: 0, buildClean: 0 },
          total: 0,
          pass: false,
          notes: `runner error: ${e instanceof Error ? e.message : String(e)}`,
          timestamp: Date.now(),
          durationMs: 0,
        };
        evaluations.push(evaluation);
        this.emitFailure(runId, fx, null, e);
      }
    }

    const summary: BenchmarkSuiteSummary = {
      suiteId,
      startedAt: t0,
      finishedAt: Date.now(),
      totalCases: cases.length,
      passedCases: passed,
      failedCases: failed,
      meanScore: cases.length > 0 ? scoreSum / cases.length : 0,
      totalDurationMs: Date.now() - t0,
      evaluations,
    };
    this.onEvent?.({ type: 'benchmark.suiteCompleted', suiteId, summary });
    return summary;
  }

  private emitFailure(
    runId: string,
    fx: GitRepoFixture,
    result: CodeTaskRunResult | null,
    err?: unknown,
  ): void {
    if (!this.evolutionHook) return;
    const message = err
      ? err instanceof Error
        ? err.message
        : String(err)
      : result
        ? `score=${result.evaluation.total.toFixed(1)}; failed rubric dimensions: ${
            Object.entries(result.evaluation.scores)
              .filter(([, v]) => v < 1)
              .map(([k]) => k)
              .join(',') || 'none'
          }`
        : 'unknown failure';
    this.evolutionHook({
      runId,
      task: fx.prompt,
      agent: 'coding-agent',
      errorCode: 'BENCH_FAIL',
      errorMessage: message,
      timestamp: Date.now(),
    });
  }
}
