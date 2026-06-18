// Evaluation Contracts — the data model for Harness (Phase 3) and
// the Evaluation Dashboard (Phase 4).
//
// A `Benchmark` is one task in a dataset. The Harness runner executes the
// agent in a Docker sandbox (see ADR 0005) against `repo` @ `baseCommit`,
// then an Evaluator scores the resulting workspace along the `rubric`.
//
// `Evaluation` is the score record persisted to SQLite. Multiple Evaluators
// (build / test / lint / coverage / LLM-Judge) contribute to a single
// Evaluation; their per-dimension scores are normalized to [0, 100] and
// combined via the weighted sum in `Benchmark.rubric`.
//
// See docs/PHASE3_HARNESS.md for end-to-end usage.

import type { ModelRef } from './run';

// ── Rubric ────────────────────────────────────────────────────────────

/** Dimension name -> weight (0-1). Weights SHOULD sum to 1.0. */
export type Rubric = Record<string, number>;

/** Single-dimension score, normalized to [0, 100]. */
export type DimensionScores = Record<string, number>;

// ── Benchmark ─────────────────────────────────────────────────────────

/**
 * One task in a benchmark dataset. Inspired by SWE-Bench:
 *   https://www.swebench.com/
 *
 * The runner:
 *  1. Creates a Docker container from `image` (or `repo`'s default).
 *  2. Checks out `repo` at `baseCommit`.
 *  3. Runs `setupScript` (e.g. `npm ci`).
 *  4. Invokes the Agent with `prompt`.
 *  5. Runs `testCommands` and judges output.
 *  6. Scores with `evaluators` and combines via `rubric`.
 */
export interface Benchmark {
  /** Stable id within the dataset, e.g. "swe-bench:lang-42" */
  id: string;
  /** Human-readable name */
  name: string;
  /** Task description given to the agent */
  prompt: string;
  /** Repo name or URL; resolved by the runner */
  repo: string;
  /** Base commit to check out before the agent runs (reproducibility) */
  baseCommit: string;
  /** Docker image; defaults to repo's bundled image */
  image?: string;
  /** Setup command(s) executed before the agent, e.g. ["npm ci"] */
  setupScript?: string[];
  /** Test/verification commands; exit code 0 == pass */
  testCommands: string[];
  /** Test files of interest (for selective execution & diff) */
  testFiles?: string[];
  /** Optional golden patch for diff-based scoring */
  referencePatch?: string;
  /** Difficulty bucket (used for slicing in Dashboard) */
  difficulty: BenchmarkDifficulty;
  /** Free-form tags, e.g. ["auth", "backend", "fix"] */
  tags: string[];
  /** Rubric used to combine per-evaluator scores into `total` */
  rubric: Rubric;
  /** Which evaluators to run; default = all supported */
  evaluators?: BenchmarkEvaluator[];
  /** Author / source attribution */
  source?: BenchmarkSource;
}

export type BenchmarkDifficulty = 'easy' | 'medium' | 'hard' | 'expert';

export type BenchmarkEvaluator =
  | 'build'
  | 'test'
  | 'lint'
  | 'coverage'
  | 'llm-judge';

export interface BenchmarkSource {
  /** Origin dataset, e.g. "SWE-Bench", "HumanEval-X" */
  dataset: string;
  /** Original id within the source dataset */
  originalId?: string;
  /** License of the benchmark; required for redistribution */
  license?: string;
}

// ── Evaluation ────────────────────────────────────────────────────────

/** The persisted record of one Benchmark run against one AgentRun. */
export interface Evaluation {
  /** Unique id */
  id: string;
  /** AgentRun that produced the work being evaluated */
  runId: string;
  /** Benchmark that was executed */
  benchmarkId: string;
  /** Per-evaluator scores (dimension name -> 0-100) */
  scores: DimensionScores;
  /** Combined score (0-100), weighted by Benchmark.rubric */
  total: number;
  /** Pass/fail against the benchmark's pass threshold (default: 60) */
  pass: boolean;
  /** Model used as LLM Judge (if `llm-judge` evaluator ran) */
  judgeModel?: ModelRef;
  /** Free-form evaluator notes, e.g. test stdout tail */
  notes?: string;
  /** Epoch milliseconds */
  timestamp: number;
  /** Wall-clock duration of the evaluation (excluding agent work) */
  durationMs: number;
}

// ── Evaluator Result (internal) ───────────────────────────────────────

/**
 * Per-evaluator intermediate result. Multiple of these combine into
 * a single Evaluation. Evaluators are pure functions:
 *   (workspace, benchmark) => EvaluatorResult
 */
export interface EvaluatorResult {
  /** Evaluator name; must be a key in Benchmark.rubric */
  name: string;
  /** Dimension scores; shape varies by evaluator */
  scores: DimensionScores;
  /** 0-100 normalized for this evaluator alone */
  score: number;
  /** Optional raw output for debugging, e.g. test stdout */
  raw?: string;
  /** When the evaluator failed, structured error */
  error?: { code: string; message: string };
}

// ── Helpers ───────────────────────────────────────────────────────────

/** Default pass threshold (out of 100). */
export const DEFAULT_PASS_THRESHOLD = 60;

/**
 * Combine per-evaluator scores using a weighted rubric.
 * Weights are normalized so missing dimensions don't zero the result.
 */
export function combineScores(
  results: EvaluatorResult[],
  rubric: Rubric
): { total: number; scores: DimensionScores } {
  const scores: DimensionScores = {};
  let weightedSum = 0;
  let weightTotal = 0;

  for (const r of results) {
    scores[r.name] = r.score;
    const w = rubric[r.name] ?? 0;
    if (w <= 0) continue;
    weightedSum += r.score * w;
    weightTotal += w;
  }

  const total = weightTotal > 0 ? weightedSum / weightTotal : 0;
  return { total, scores };
}

/** Decide pass/fail from total score and threshold. */
export function decidePass(total: number, threshold = DEFAULT_PASS_THRESHOLD): boolean {
  return total >= threshold;
}

// ── Baseline ──────────────────────────────────────────────────────────

/**
 * A frozen snapshot of Evaluation results for one Benchmark, used as
 * the reference point for "did this change make us better or worse?".
 *
 * Baselines are immutable once written. To track progress over time,
 * create a new baseline (e.g. "v0.3-stable", "v0.4-rc1") and compare
 * live evaluations against it.
 */
export interface Baseline {
  /** Stable id; typically `<benchmarkId>:<label>`. */
  id: string;
  /** Human-readable label, e.g. "v0.3-stable" */
  name: string;
  /** Benchmark this baseline is for. */
  benchmarkId: string;
  /** Snapshot of Evaluation records at baseline time. */
  evaluations: Evaluation[];
  /** Optional description / changelog. */
  description?: string;
  /** Epoch milliseconds. */
  createdAt: number;
}

/**
 * Aggregated, comparable view of a Benchmark's Evaluation set.
 * Used for the "this run vs baseline" delta in the dashboard.
 */
export interface EvaluationAggregate {
  count: number;
  passCount: number;
  passRate: number;
  avgScore: number;
  avgDurationMs: number;
  /** Pass@1 = pass rate (single shot); Pass@3 = fraction of tasks that
   *  had at least one pass in any 3 consecutive runs. We approximate
   *  Pass@3 here as a 3-window moving pass rate for simplicity. */
  passAt1: number;
  passAt3: number;
  totalTokensIn: number;
  totalTokensOut: number;
  totalCostUsd: number;
}

/**
 * Compute a comparable aggregate from a list of Evaluations.
 * The list is treated as the full sample; Pass@1 = pass rate,
 * Pass@3 = rolling-window pass rate over 3 consecutive evals.
 */
export function aggregateEvaluations(evals: Evaluation[]): EvaluationAggregate {
  if (evals.length === 0) {
    return {
      count: 0,
      passCount: 0,
      passRate: 0,
      avgScore: 0,
      avgDurationMs: 0,
      passAt1: 0,
      passAt3: 0,
      totalTokensIn: 0,
      totalTokensOut: 0,
      totalCostUsd: 0,
    };
  }
  const sorted = [...evals].sort((a, b) => a.timestamp - b.timestamp);
  const passCount = sorted.filter((e) => e.pass).length;
  const passRate = passCount / sorted.length;
  const avgScore =
    sorted.reduce((s, e) => s + (e.total ?? 0), 0) / sorted.length;
  const avgDurationMs =
    sorted.reduce((s, e) => s + (e.durationMs ?? 0), 0) / sorted.length;

  // Pass@3: rolling 3-window pass rate averaged across windows.
  let pass3Sum = 0;
  let pass3N = 0;
  for (let i = 0; i + 2 < sorted.length; i++) {
    const w = sorted.slice(i, i + 3);
    pass3Sum += w.some((e) => e.pass) ? 1 : 0;
    pass3N++;
  }
  const passAt3 = pass3N > 0 ? pass3Sum / pass3N : passRate;

  return {
    count: sorted.length,
    passCount,
    passRate,
    avgScore,
    avgDurationMs,
    passAt1: passRate,
    passAt3,
    totalTokensIn: 0,  // tokens tracked at Run level, not Eval
    totalTokensOut: 0,
    totalCostUsd: 0,
  };
}

/** Delta between two aggregates, in the same units. */
export interface EvaluationDelta {
  metric: keyof EvaluationAggregate;
  before: number;
  after: number;
  /** `after - before`; positive = improvement for passRate/avgScore,
   *  negative = improvement for cost/duration. */
  diff: number;
  /** 0..1 normalized improvement score; computed for sortable display. */
  pctChange: number;
}

// ── Prompt Candidate (Phase 5) ────────────────────────────────────────

/**
 * A single prompt variant. Multiple variants of the same `candidateId`
 * form an A/B test set; one is `active`.
 */
export interface PromptVariant {
  id: string;
  /** Free-form label, e.g. "control", "A", "B". */
  label: string;
  /** The actual prompt text (or its hash for very long prompts). */
  content: string;
  /** Optional free-form notes / changelog. */
  notes?: string;
  /** Epoch milliseconds. */
  createdAt: number;
}

/**
 * A named prompt candidate — e.g. one Agent's system prompt and
 * its experimental variants. Stats per variant are computed from
 * the Run / Eval history (see QueryService.variantStats).
 */
export interface PromptCandidate {
  id: string;
  /** Which agent this candidate is for; the key in AgentRegistry. */
  agentName: string;
  /** Human-readable name, e.g. "planner-default". */
  name: string;
  variants: PromptVariant[];
  /** Currently active variant id. */
  activeVariantId: string;
  createdAt: number;
  updatedAt: number;
}

/** Per-variant aggregate performance, computed from Run/Eval history. */
export interface VariantStats {
  variantId: string;
  label: string;
  runCount: number;
  passRate: number;
  avgScore: number;
  avgCostUsd: number;
  avgDurationMs: number;
  /** Last time a Run tagged with this variant was recorded. */
  lastSeen: number;
}

/**
 * Build a row of deltas for the "vs baseline" table. Improvement
 * direction is "higher is better" for pass/score metrics and
 * "lower is better" for cost/duration.
 */
export function diffAggregates(
  before: EvaluationAggregate,
  after: EvaluationAggregate,
): EvaluationDelta[] {
  const rows: Array<{ metric: keyof EvaluationAggregate; higherIsBetter: boolean }> = [
    { metric: 'passRate', higherIsBetter: true },
    { metric: 'avgScore', higherIsBetter: true },
    { metric: 'passAt1', higherIsBetter: true },
    { metric: 'passAt3', higherIsBetter: true },
    { metric: 'avgDurationMs', higherIsBetter: false },
    { metric: 'count', higherIsBetter: true },
  ];
  return rows.map((r) => {
    const a = before[r.metric] as number;
    const b = after[r.metric] as number;
    const diff = b - a;
    const pctChange = a === 0 ? (b === 0 ? 0 : 1) : diff / Math.abs(a);
    return { metric: r.metric, before: a, after: b, diff, pctChange };
  });
}
