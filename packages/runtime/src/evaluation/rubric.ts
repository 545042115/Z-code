// RubricScorer — turns a SandboxResult + spec into a numeric score.
//
// A `Rubric` is a map of dimension-name to weight (sum to 1.0). Each
// check contributes to one dimension; final score is the weighted sum
// of per-dimension scores, normalized to [0, 100]. Pass/fail threshold
// is configurable per RubricSpec.
//
// Phase 6A: moved from V1 `extensions/coding-agent/src/harness/rubric.ts`
// to V2 `packages/runtime/src/evaluation/rubric.ts`. Pure Node, no vscode.

import type { Rubric, Evaluation } from '@ziner/contracts';
import type { SandboxResult } from './sandbox';
export type { Evaluation } from '@ziner/contracts';

export type RubricCheck = (result: SandboxResult, evalCtx: Record<string, unknown>) => Promise<number> | number;

export interface RubricSpec {
  id: string;
  name: string;
  /** Per-dimension weight (sum to 1.0). */
  weights: Rubric;
  /** Checks keyed by dimension name; each must align with a weight. */
  checks: Record<string, RubricCheck>;
  /** 0-100. Default 60. */
  passThreshold: number;
}

/**
 * Score a single SandboxResult against a RubricSpec.
 * Returns scores per dimension (0-1) and a total (0-100).
 */
export async function scoreSandboxResult(
  result: SandboxResult,
  rubric: RubricSpec
): Promise<{ total: number; scores: Record<string, number>; passed: boolean }> {
  const dims = Object.keys(rubric.weights);
  if (dims.length === 0) {
    return { total: 0, scores: {}, passed: false };
  }
  const scores: Record<string, number> = {};
  let weightedSum = 0;
  let totalWeight = 0;
  for (const dim of dims) {
    const w = rubric.weights[dim];
    const check = rubric.checks[dim];
    let s = 0;
    if (check) {
      try {
        s = Number(await check(result, {}));
        if (!Number.isFinite(s)) s = 0;
      } catch {
        s = 0;
      }
    }
    scores[dim] = s;
    weightedSum += s * w;
    totalWeight += w;
  }
  const total = totalWeight > 0 ? (weightedSum / totalWeight) * 100 : 0;
  const passed = total >= rubric.passThreshold;
  return { total, scores, passed };
}

// ── Built-in checks ────────────────────────────────────────────────────

/** Exit code equals 0. */
export const exitCodeZero: RubricCheck = (r) => (r.exitCode === 0 ? 1 : 0);

/** Did not time out. */
export const noTimeout: RubricCheck = (r) => (r.timedOut ? 0 : 1);

/** Stdout matches a regex (returns match strength 0..1). */
export function stdoutMatches(re: RegExp): RubricCheck {
  return (r) => {
    const m = r.stdout.match(re);
    return m ? 1 : 0;
  };
}

/** Stderr is empty. */
export const noStderr: RubricCheck = (r) => (r.stderr.trim() === '' ? 1 : 0);

/** Some artifacts were produced. */
export function minArtifacts(n: number): RubricCheck {
  return (r) => (r.artifacts.length >= n ? 1 : r.artifacts.length / n);
}

/** Specific artifact file exists. */
export function hasArtifact(path: string): RubricCheck {
  return (r) => (r.artifacts.includes(path) ? 1 : 0);
}

/** Duration under cap. */
export function durationUnderMs(ms: number): RubricCheck {
  return (r) => (r.durationMs <= ms ? 1 : 0);
}

/** Combine checks: each must return >= threshold (default 1) to count as 1; otherwise 0. */
export function allOf(checks: RubricCheck[], threshold = 1): RubricCheck {
  return async (r, ctx) => {
    const out = await Promise.all(checks.map((c) => c(r, ctx)));
    return out.every((s) => s >= threshold) ? 1 : 0;
  };
}

// ── Code-task checks (used by CodingAgentRunner) ───────────────────────
//
// The CodingAgentRunner (see coding-task-runner.ts) writes a `grader.json`
// inside the workdir before tearing down the container. The grader
// script (provided by each fixture) writes fields like:
//
//   { "testsPassed": 42, "testsFailed": 0, "patchApplied": true, "buildClean": true }
//
// We surface these via `evalCtx` (the second arg to RubricCheck). The
// contract: a fixture can use any of these names; missing fields score 0.

/**
 * True iff the agent's diff was applied (grader detected changes in
 * the expected files). Score 1 if applied, 0 if not, fractional
 * (appliedFiles / expectedFiles) when the grader reports a count.
 */
export const patchApplied: RubricCheck = (_r, ctx) => {
  const v = (ctx as Record<string, unknown>)['patchApplied'];
  if (v === true) return 1;
  if (v === false) return 0;
  const a = (ctx as Record<string, number>)['appliedFiles'];
  const e = (ctx as Record<string, number>)['expectedFiles'];
  if (typeof a === 'number' && typeof e === 'number' && e > 0) {
    return Math.max(0, Math.min(1, a / e));
  }
  return 0;
};

/**
 * All test cases in the fixture's test suite passed.
 * Score = passed / (passed + failed). 1.0 if no tests failed.
 */
export const testsPassed: RubricCheck = (_r, ctx) => {
  const p = (ctx as Record<string, number>)['testsPassed'];
  const f = (ctx as Record<string, number>)['testsFailed'];
  if (typeof p !== 'number') return 0;
  if (typeof f !== 'number' || f === 0) return 1;
  return Math.max(0, p / (p + f));
};

/** Build completed cleanly (no compile errors). */
export const buildClean: RubricCheck = (r, ctx) => {
  if (typeof (ctx as Record<string, unknown>)['buildClean'] === 'boolean') {
    return (ctx as Record<string, boolean>)['buildClean'] ? 1 : 0;
  }
  // Fallback: no compile errors mentioned in stderr
  return /error[: ]|cannot find|undefined reference/i.test(r.stderr) ? 0 : 1;
};

// ── Result adapter ─────────────────────────────────────────────────────

/** Convert score output to the contract `Evaluation` shape. */
export function makeEvaluation(args: {
  id: string;
  benchmarkId: string;
  runId: string;
  candidate: string;
  scores: Record<string, number>;
  total: number;
  passed: boolean;
  notes?: string;
  startedAt: number;
  finishedAt: number;
  error?: { code: string; message: string };
}): Evaluation {
  return {
    id: args.id,
    benchmarkId: args.benchmarkId,
    runId: args.runId,
    scores: args.scores,
    total: args.total,
    pass: args.passed,
    notes: args.notes,
    timestamp: args.finishedAt,
    durationMs: args.finishedAt - args.startedAt,
    // Error is captured in notes (contract has no error field on Evaluation)
  };
}
