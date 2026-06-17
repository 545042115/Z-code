// RubricScorer — turns a SandboxResult + spec into a numeric score.
//
// A `Rubric` is a map of dimension-name to weight (sum to 1.0). Each
// check contributes to one dimension; final score is the weighted sum
// of per-dimension scores, normalized to [0, 100]. Pass/fail threshold
// is configurable per RubricSpec.

import type { Rubric, Evaluation } from '../contracts';
import type { SandboxResult } from './sandbox';
export type { Evaluation } from '../contracts';

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
