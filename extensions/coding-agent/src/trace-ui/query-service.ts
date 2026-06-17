// QueryService — caching query layer for the Trace UI.
//
// Wraps a Store with a simple in-memory cache that invalidates when
// mutations are observed. The UI subscribes to invalidation events
// and refetches.
//
// Why a service and not direct Store calls:
//   - UI needs aggregated queries (run summary, span stats) not in Store
//   - Avoid re-reading JSONL on every keystroke
//   - Centralize projection logic (e.g. timeline buckets)

import type { Store, RunQuery, SpanQuery } from '../infra/storage';
import type {
  AgentRun,
  AgentSpan,
  RunStatus,
  SpanStatus,
  SpanType,
  Evaluation,
  Benchmark,
  Baseline,
  EvaluationAggregate,
  EvaluationDelta,
  PromptCandidate,
  PromptVariant,
  VariantStats,
} from '../contracts';
import {
  aggregateEvaluations,
  diffAggregates,
} from '../contracts';

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

/** Listener invoked on cache invalidation. */
export type InvalidationListener = (key: string) => void;

export class QueryService {
  private _cache = new Map<string, unknown>();
  private _listeners: InvalidationListener[] = [];

  constructor(private readonly store: Store) {}

  // ── Subscriptions ───────────────────────────────────────────────────

  subscribe(fn: InvalidationListener): () => void {
    this._listeners.push(fn);
    return () => {
      this._listeners = this._listeners.filter((x) => x !== fn);
    };
  }

  /** Invalidate one or more cache keys and notify listeners. */
  invalidate(...keys: string[]): void {
    for (const k of keys) this._cache.delete(k);
    for (const fn of this._listeners) fn(keys.join(','));
  }

  /** Drop all cached entries. */
  clear(): void {
    this._cache.clear();
    for (const fn of this._listeners) fn('*');
  }

  // ── Queries (cached) ────────────────────────────────────────────────

  /** List Runs as lightweight summaries. */
  async listRuns(q: RunQuery = {}): Promise<RunSummary[]> {
    const key = `runs:${JSON.stringify(q)}`;
    const hit = this._cache.get(key) as RunSummary[] | undefined;
    if (hit) return hit;
    const runs = await this.store.runs.list(q);
    const out: RunSummary[] = await Promise.all(
      runs.map(async (r) => {
        const spans = await this.store.spans.listByRun(r.id);
        return {
          id: r.id,
          traceId: r.traceId,
          task: r.task,
          model: r.model,
          startTime: r.startTime,
          endTime: r.endTime,
          duration: r.duration,
          status: r.status,
          totalTokensIn: r.totalTokensIn,
          totalTokensOut: r.totalTokensOut,
          totalCostUsd: r.totalCostUsd,
          spanCount: spans.length,
          errorSpanCount: spans.filter((s) => s.status === 'error').length,
          tags: r.tags,
        };
      })
    );
    this._cache.set(key, out);
    return out;
  }

  /** Get a single Run by id. */
  async getRun(id: string): Promise<AgentRun | undefined> {
    const key = `run:${id}`;
    const hit = this._cache.get(key);
    if (hit !== undefined) return hit as AgentRun;
    const r = await this.store.runs.get(id);
    if (r) this._cache.set(key, r);
    return r;
  }

  /** List Spans of a Run as UI-friendly nodes. */
  async listSpanNodes(runId: string): Promise<SpanNode[]> {
    const key = `spans:${runId}`;
    const hit = this._cache.get(key) as SpanNode[] | undefined;
    if (hit) return hit;
    const spans = await this.store.spans.listByRun(runId);
    const childCount = new Map<string, number>();
    for (const s of spans) {
      if (s.parentSpanId) {
        childCount.set(s.parentSpanId, (childCount.get(s.parentSpanId) ?? 0) + 1);
      }
    }
    const out: SpanNode[] = spans.map((s) => ({
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
    }));
    this._cache.set(key, out);
    return out;
  }

  /** Get a full Span record (with input/output/events) by id. */
  async getSpan(id: string): Promise<AgentSpan | undefined> {
    return this.store.spans.get(id);
  }

  /** Read all events for a Run, in ts order. */
  async readEvents(runId: string): Promise<SpanEventLite[]> {
    const key = `events:${runId}`;
    const hit = this._cache.get(key) as SpanEventLite[] | undefined;
    if (hit) return hit;
    const out: SpanEventLite[] = [];
    for await (const ev of this.store.traceStream(runId)) {
      out.push({ ts: ev.ts, name: ev.name, attributes: ev.attributes });
    }
    this._cache.set(key, out);
    return out;
  }

  // ── Mutations (invalidate) ──────────────────────────────────────────

  async onRunCreated(): Promise<void> {
    this.invalidate('runs:*');
  }
  async onRunUpdated(id: string): Promise<void> {
    this.invalidate(`runs:*`, `run:${id}`, `spans:${id}`, `events:${id}`);
  }
  async onSpanAppended(runId: string): Promise<void> {
    this.invalidate(`spans:${runId}`, `events:${runId}`, `runs:*`);
  }

  // ── Evaluations (Phase 4) ──────────────────────────────────────────

  async listEvaluations(q: {
    benchmarkId?: string;
    pass?: boolean;
    limit?: number;
  } = {}): Promise<import('../contracts').Evaluation[]> {
    const key = `evals:${q.benchmarkId ?? '*'}:${q.pass ?? '*'}:${q.limit ?? 200}`;
    const cached = this._cache.get(key);
    if (cached) return cached as import('../contracts').Evaluation[];
    const out = await this.store.evals.list({
      benchmarkId: q.benchmarkId,
      pass: q.pass,
      limit: q.limit ?? 200,
    });
    this._cache.set(key, out);
    return out;
  }

  async listBenchmarks(): Promise<import('../contracts').Benchmark[]> {
    const key = 'benchmarks:*';
    const cached = this._cache.get(key);
    if (cached) return cached as import('../contracts').Benchmark[];
    const out = await this.store.benchmarks.list({});
    this._cache.set(key, out);
    return out;
  }

  async passRate(q: { benchmarkId?: string } = {}): Promise<number> {
    const key = `passRate:${q.benchmarkId ?? '*'}`;
    const cached = this._cache.get(key);
    if (typeof cached === 'number') return cached;
    const out = await this.store.evals.passRate({ benchmarkId: q.benchmarkId });
    this._cache.set(key, out);
    return out;
  }

  /**
   * Compute the score trend over the last N evaluations.
   * Returns an ordered array of {timestamp, total, pass}.
   */
  async scoreTrend(limit = 50): Promise<Array<{ timestamp: number; total: number; pass: boolean }>> {
    const key = `trend:${limit}`;
    const cached = this._cache.get(key);
    if (cached) return cached as Array<{ timestamp: number; total: number; pass: boolean }>;
    const evals = await this.store.evals.list({ limit });
    const out = evals
      .filter((e: import('../contracts').Evaluation) => e.timestamp != null)
      .sort((a: import('../contracts').Evaluation, b: import('../contracts').Evaluation) => (a.timestamp! - b.timestamp!))
      .map((e: import('../contracts').Evaluation) => ({ timestamp: e.timestamp!, total: e.total ?? 0, pass: !!e.pass }));
    this._cache.set(key, out);
    return out;
  }

  onEvaluationAppended(): void {
    this.invalidate('evals:*', 'passRate:*', 'benchmarks:*');
  }

  // ── Baselines (Phase 4) ────────────────────────────────────────────

  async listBaselines(q: { benchmarkId?: string } = {}): Promise<Baseline[]> {
    const key = `baselines:${q.benchmarkId ?? '*'}`;
    const cached = this._cache.get(key);
    if (cached) return cached as Baseline[];
    const out = await this.store.baselines.list({
      benchmarkId: q.benchmarkId,
    });
    this._cache.set(key, out);
    return out;
  }

  async getBaseline(id: string): Promise<Baseline | undefined> {
    const key = `baseline:${id}`;
    const cached = this._cache.get(key);
    if (cached !== undefined) return cached as Baseline;
    const out = await this.store.baselines.get(id);
    if (out) this._cache.set(key, out);
    return out;
  }

  /**
   * Snapshot the current Evaluations for a benchmark as a new Baseline.
   * Returns the created record.
   */
  async createBaseline(args: {
    benchmarkId: string;
    name: string;
    description?: string;
  }): Promise<Baseline> {
    const evals = await this.store.evals.list({ benchmarkId: args.benchmarkId });
    const id = `${args.benchmarkId}:${args.name}`;
    const baseline: Baseline = {
      id,
      benchmarkId: args.benchmarkId,
      name: args.name,
      evaluations: evals,
      description: args.description,
      createdAt: Date.now(),
    };
    await this.store.baselines.upsert(baseline);
    this.invalidate(`baselines:${args.benchmarkId}`, `baseline:${id}`);
    return baseline;
  }

  async deleteBaseline(id: string): Promise<void> {
    await this.store.baselines.delete(id);
    this.invalidate('baselines:*', `baseline:${id}`);
  }

  /**
   * Compare a live (recent) set of Evaluations against a Baseline.
   * Returns aggregate metrics for both sides and a row of deltas.
   */
  async compareToBaseline(args: {
    baselineId: string;
    recentLimit?: number;
  }): Promise<{
    baseline: EvaluationAggregate;
    current: EvaluationAggregate;
    deltas: EvaluationDelta[];
  }> {
    const baselineRec = await this.getBaseline(args.baselineId);
    if (!baselineRec) {
      return {
        baseline: aggregateEvaluations([]),
        current: aggregateEvaluations([]),
        deltas: [],
      };
    }
    const baseline = aggregateEvaluations(baselineRec.evaluations);
    const since = baselineRec.createdAt;
    const currentList = await this.store.evals.list({
      benchmarkId: baselineRec.benchmarkId,
      fromTs: since,
      limit: args.recentLimit ?? 200,
    });
    const current = aggregateEvaluations(currentList);
    return {
      baseline,
      current,
      deltas: diffAggregates(baseline, current),
    };
  }

  onBaselineChanged(): void {
    this.invalidate('baselines:*', 'baseline:*');
  }

  // ── Prompt candidates (Phase 5) ────────────────────────────────────

  async listCandidates(q: { agentName?: string } = {}): Promise<PromptCandidate[]> {
    const key = `candidates:${q.agentName ?? '*'}`;
    const cached = this._cache.get(key);
    if (cached) return cached as PromptCandidate[];
    const out = await this.store.candidates.list({ agentName: q.agentName });
    this._cache.set(key, out);
    return out;
  }

  async getCandidate(id: string): Promise<PromptCandidate | undefined> {
    const key = `candidate:${id}`;
    const cached = this._cache.get(key);
    if (cached !== undefined) return cached as PromptCandidate;
    const out = await this.store.candidates.get(id);
    if (out) this._cache.set(key, out);
    return out;
  }

  /**
   * Create or update a PromptCandidate. If the candidate exists,
   * the variants array is replaced wholesale (caller controls it).
   */
  async upsertCandidate(args: {
    id: string;
    agentName: string;
    name: string;
    variants: PromptVariant[];
    activeVariantId: string;
  }): Promise<PromptCandidate> {
    const now = Date.now();
    const existing = await this.getCandidate(args.id);
    const c: PromptCandidate = {
      id: args.id,
      agentName: args.agentName,
      name: args.name,
      variants: args.variants,
      activeVariantId: args.activeVariantId,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    await this.store.candidates.upsert(c);
    this.invalidate(`candidates:${args.agentName}`, `candidates:*`, `candidate:${c.id}`);
    return c;
  }

  async deleteCandidate(id: string): Promise<void> {
    await this.store.candidates.delete(id);
    this.invalidate('candidates:*', `candidate:${id}`);
  }

  /**
   * Compute per-variant performance stats from Runs tagged with
   * `tags: ["variant:<variantId>"]`. Returns one VariantStats per
   * variant in the candidate (even if no runs yet).
   */
  async variantStats(candidateId: string): Promise<VariantStats[]> {
    const c = await this.getCandidate(candidateId);
    if (!c) return [];
    const out: VariantStats[] = [];
    for (const v of c.variants) {
      const tag = `variant:${v.id}`;
      const runs = await this.store.runs.list({ tagsAny: [tag], limit: 500 });
      const n = runs.length;
      const successCount = runs.filter((r) => r.status === 'success').length;
      const passRate = n ? successCount / n : 0;
      const avgScore = n
        ? runs.reduce((s, r) => {
            // crude: use total cost as a proxy if no other field; this is
            // a placeholder for the real Eval-level score. Real impl
            // should join Evaluations by runId.
            return s + r.totalCostUsd;
          }, 0) / n
        : 0;
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
        avgScore,
        avgCostUsd: avgCost,
        avgDurationMs: avgDur,
        lastSeen,
      });
    }
    return out;
  }

  // ── Optimizer stats (Phase 5) ──────────────────────────────────────

  /**
   * Per-tool usage + success rate. Reads all spans of `type=tool`.
   * Used by the "Tool Optimizer" section of the Evolution panel
   * (per PHASE5_EVOLUTION.md: "统计 Tool Usage + Success Rate").
   */
  async toolUsage(windowMs = 7 * 24 * 60 * 60 * 1000): Promise<
    Array<{ name: string; calls: number; ok: number; error: number; successRate: number; avgDurationMs: number }>
  > {
    const fromTs = Date.now() - windowMs;
    const runs = await this.store.runs.list({ fromTs, limit: 1000 });
    const byName = new Map<string, { calls: number; ok: number; error: number; durSum: number; durN: number }>();
    for (const r of runs) {
      const spans = await this.store.spans.listByRun(r.id, { type: 'tool' });
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

  /**
   * Per-skill hit rate and success rate. Reads spans of `type=skill`.
   * Used by the "Skill Optimizer" section (per PHASE5_EVOLUTION.md:
   * "Skill Hit Rate + Success Rate").
   */
  async skillUsage(windowMs = 7 * 24 * 60 * 60 * 1000): Promise<
    Array<{ name: string; hits: number; successRate: number }>
  > {
    const fromTs = Date.now() - windowMs;
    const runs = await this.store.runs.list({ fromTs, limit: 1000 });
    const byName = new Map<string, { hits: number; ok: number }>();
    for (const r of runs) {
      const spans = await this.store.spans.listByRun(r.id, { type: 'skill' });
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
}
