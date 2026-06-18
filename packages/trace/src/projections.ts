// Trace Projections — pure transformation functions over Store data.
//
// These functions are intentionally side-effect free and store-agnostic
// (the caller supplies the records it has read). They live in V2 so the
// CLI / desktop / vscode-connector can all build the same UI shapes
// without depending on the V1 QueryService's cache.
//
// Heavyweight operations (multi-record aggregations, baseline comparisons)
// live here so they can be unit-tested without spinning up a Store.

import type { Store, RunQuery, SpanQuery } from '@z-assistant/infra-storage';
import type {
  AgentRun,
  AgentSpan,
  RunStatus,
  SpanStatus,
  SpanType,
  Evaluation,
  Baseline,
  PromptCandidate,
  VariantStats,
  EvaluationAggregate,
  EvaluationDelta,
} from '@z-assistant/contracts';
import {
  aggregateEvaluations,
  diffAggregates,
} from '@z-assistant/contracts';

// ── UI-shaped records ─────────────────────────────────────────────────

export interface RunSummary {
  id: string;
  traceId: string;
  task: string;
  model: { provider: string; name: string };
  startTime: number;
  endTime?: number;
  duration?: number;
  status: RunStatus;
  totalTokensIn: number;
  totalTokensOut: number;
  totalCostUsd: number;
  spanCount: number;
  errorSpanCount: number;
  tags: string[];
}

export interface SpanNode {
  id: string;
  parentSpanId?: string;
  name: string;
  type: SpanType;
  startTime: number;
  endTime?: number;
  duration?: number;
  status: SpanStatus;
  agent?: string;
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
  hasError: boolean;
  errorCode?: string;
  /** Number of events on the Span */
  eventCount: number;
  /** Number of child Spans */
  childCount: number;
}

export interface SpanEventLite {
  ts: number;
  name: string;
  attributes?: Record<string, string | number | boolean | null>;
}

// ── Run / Span projections ────────────────────────────────────────────

/** Project a Run + its Spans into a UI summary. */
export function projectRunSummary(run: AgentRun, spans: AgentSpan[]): RunSummary {
  return {
    id: run.id,
    traceId: run.traceId,
    task: run.task,
    model: run.model,
    startTime: run.startTime,
    endTime: run.endTime,
    duration: run.duration,
    status: run.status,
    totalTokensIn: run.totalTokensIn,
    totalTokensOut: run.totalTokensOut,
    totalCostUsd: run.totalCostUsd,
    spanCount: spans.length,
    errorSpanCount: spans.filter((s) => s.status === 'error').length,
    tags: run.tags,
  };
}

/** Build a childCount map from a flat Span list. */
export function buildChildCountMap(spans: AgentSpan[]): Map<string, number> {
  const childCount = new Map<string, number>();
  for (const s of spans) {
    if (s.parentSpanId) {
      childCount.set(s.parentSpanId, (childCount.get(s.parentSpanId) ?? 0) + 1);
    }
  }
  return childCount;
}

/** Project a Span into a UI node, given a pre-computed childCount map. */
export function projectSpanNode(s: AgentSpan, childCount: Map<string, number>): SpanNode {
  return {
    id: s.id,
    parentSpanId: s.parentSpanId,
    name: s.name,
    type: s.type,
    startTime: s.startTime,
    endTime: s.endTime,
    duration: s.duration,
    status: s.status,
    agent: s.agent,
    tokensIn: s.tokensIn,
    tokensOut: s.tokensOut,
    costUsd: s.costUsd,
    hasError: s.status === 'error',
    errorCode: s.error?.code,
    eventCount: s.events?.length ?? 0,
    childCount: childCount.get(s.id) ?? 0,
  };
}

/** Trim a SpanEvent down to the fields the UI needs. */
export function projectSpanEvent(ev: { ts: number; name: string; attributes?: Record<string, string | number | boolean | null> }): SpanEventLite {
  return { ts: ev.ts, name: ev.name, attributes: ev.attributes };
}

// ── Evaluation projections ────────────────────────────────────────────

/** Compute the score trend over the last N evaluations. */
export function computeScoreTrend(evals: Evaluation[], limit = 50): Array<{ timestamp: number; total: number; pass: boolean }> {
  return evals
    .filter((e) => e.timestamp != null)
    .sort((a, b) => (a.timestamp! - b.timestamp!))
    .map((e) => ({ timestamp: e.timestamp!, total: e.total ?? 0, pass: !!e.pass }))
    .slice(-limit);
}

// ── Baseline projections ──────────────────────────────────────────────

/** Build a Baseline record from a snapshot of Evaluations. */
export function buildBaseline(args: {
  benchmarkId: string;
  name: string;
  description?: string;
  evaluations: Evaluation[];
  now?: number;
}): Baseline {
  const now = args.now ?? Date.now();
  return {
    id: `${args.benchmarkId}:${args.name}`,
    benchmarkId: args.benchmarkId,
    name: args.name,
    evaluations: args.evaluations,
    description: args.description,
    createdAt: now,
  };
}

/**
 * Compare a live (recent) set of Evaluations against a Baseline.
 * Returns aggregate metrics for both sides and a row of deltas.
 */
export function diffBaseline(args: {
  baseline: Baseline | undefined;
  currentList: Evaluation[];
}): { baseline: EvaluationAggregate; current: EvaluationAggregate; deltas: EvaluationDelta[] } {
  if (!args.baseline) {
    return {
      baseline: aggregateEvaluations([]),
      current: aggregateEvaluations([]),
      deltas: [],
    };
  }
  const baseline = aggregateEvaluations(args.baseline.evaluations);
  const current = aggregateEvaluations(args.currentList);
  return {
    baseline,
    current,
    deltas: diffAggregates(baseline, current),
  };
}

// ── Optimizer projections (Phase 5) ──────────────────────────────────

/** Per-tool usage + success rate from a Run + its Spans. */
export function projectToolUsage(
  runs: AgentRun[],
  spansByRun: Map<string, AgentSpan[]>,
): Array<{ name: string; calls: number; ok: number; error: number; successRate: number; avgDurationMs: number }> {
  const byName = new Map<string, { calls: number; ok: number; error: number; durSum: number; durN: number }>();
  for (const r of runs) {
    const spans = spansByRun.get(r.id) ?? [];
    for (const s of spans) {
      let e = byName.get(s.name);
      if (!e) { e = { calls: 0, ok: 0, error: 0, durSum: 0, durN: 0 }; byName.set(s.name, e); }
      e.calls++;
      if (s.status === 'ok') e.ok++;
      else if (s.status === 'error') e.error++;
      if (s.duration !== undefined) { e.durSum += s.duration; e.durN++; }
    }
  }
  return [...byName.entries()]
    .map(([name, e]) => ({
      name,
      calls: e.calls,
      ok: e.ok,
      error: e.error,
      successRate: e.calls ? e.ok / e.calls : 0,
      avgDurationMs: e.durN ? e.durSum / e.durN : 0,
    }))
    .sort((a, b) => b.calls - a.calls);
}

/** Per-skill hit rate and success rate from a Run + its Spans. */
export function projectSkillUsage(
  runs: AgentRun[],
  spansByRun: Map<string, AgentSpan[]>,
): Array<{ name: string; hits: number; successRate: number }> {
  const byName = new Map<string, { hits: number; ok: number }>();
  for (const r of runs) {
    const spans = spansByRun.get(r.id) ?? [];
    for (const s of spans) {
      let e = byName.get(s.name);
      if (!e) { e = { hits: 0, ok: 0 }; byName.set(s.name, e); }
      e.hits++;
      if (s.status === 'ok') e.ok++;
    }
  }
  return [...byName.entries()]
    .map(([name, e]) => ({
      name,
      hits: e.hits,
      successRate: e.hits ? e.ok / e.hits : 0,
    }))
    .sort((a, b) => b.hits - a.hits);
}

/** Compute per-variant performance stats from runs tagged with `variant:<id>`. */
export function projectVariantStats(args: {
  candidate: PromptCandidate | undefined;
  runs: AgentRun[];
}): VariantStats[] {
  if (!args.candidate) return [];
  const out: VariantStats[] = [];
  for (const v of args.candidate.variants) {
    const tag = `variant:${v.id}`;
    const runs = args.runs.filter((r) => r.tags.includes(tag));
    const n = runs.length;
    const successCount = runs.filter((r) => r.status === 'success').length;
    const passRate = n ? successCount / n : 0;
    const avgCost = n ? runs.reduce((s, r) => s + r.totalCostUsd, 0) / n : 0;
    const avgDur = n
      ? runs.reduce((s, r) => s + (r.duration ?? (r.endTime ? r.endTime - r.startTime : 0)), 0) / n
      : 0;
    const lastSeen = n
      ? Math.max(...runs.map((r) => r.endTime ?? r.startTime))
      : 0;
    out.push({
      variantId: v.id,
      label: v.label,
      runCount: n,
      passRate,
      // Placeholder for real Eval-level score; legacy V1 stored totalCostUsd.
      avgScore: avgCost,
      avgCostUsd: avgCost,
      avgDurationMs: avgDur,
      lastSeen,
    });
  }
  return out;
}

// ── Store-backed wrappers (load + project in one call) ────────────────

/**
 * List Runs as lightweight summaries. Reads the underlying Spans to
 * compute spanCount / errorSpanCount.
 */
export async function listRunSummaries(store: Store, q: RunQuery = {}): Promise<RunSummary[]> {
  const runs = await store.runs.list(q);
  return Promise.all(
    runs.map(async (r) => {
      const spans = await store.spans.listByRun(r.id);
      return projectRunSummary(r, spans);
    }),
  );
}

/** List Spans of a Run as UI-friendly nodes, with childCount pre-computed. */
export async function listSpanNodes(store: Store, runId: string): Promise<SpanNode[]> {
  const spans = await store.spans.listByRun(runId);
  const childCount = buildChildCountMap(spans);
  return spans.map((s) => projectSpanNode(s, childCount));
}

/** Read all events for a Run, in ts order, as lightweight records. */
export async function readRunEvents(store: Store, runId: string): Promise<SpanEventLite[]> {
  const out: SpanEventLite[] = [];
  for await (const ev of store.traceStream(runId)) {
    out.push(projectSpanEvent(ev));
  }
  return out;
}

/** List tool-usage stats over a recent window (default 7d). */
export async function listToolUsage(
  store: Store,
  windowMs = 7 * 24 * 60 * 60 * 1000,
): Promise<Array<{ name: string; calls: number; ok: number; error: number; successRate: number; avgDurationMs: number }>> {
  const fromTs = Date.now() - windowMs;
  const runs = await store.runs.list({ fromTs, limit: 1000 });
  const spansByRun = new Map<string, AgentSpan[]>();
  for (const r of runs) {
    spansByRun.set(r.id, await store.spans.listByRun(r.id, { type: 'tool' } as SpanQuery));
  }
  return projectToolUsage(runs, spansByRun);
}

/** List skill-usage stats over a recent window (default 7d). */
export async function listSkillUsage(
  store: Store,
  windowMs = 7 * 24 * 60 * 60 * 1000,
): Promise<Array<{ name: string; hits: number; successRate: number }>> {
  const fromTs = Date.now() - windowMs;
  const runs = await store.runs.list({ fromTs, limit: 1000 });
  const spansByRun = new Map<string, AgentSpan[]>();
  for (const r of runs) {
    spansByRun.set(r.id, await store.spans.listByRun(r.id, { type: 'skill' } as SpanQuery));
  }
  return projectSkillUsage(runs, spansByRun);
}
