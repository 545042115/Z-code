// QueryService — V1 caching query layer for the Trace UI.
//
// Wraps a Store with a simple in-memory cache that invalidates when
// mutations are observed. The UI subscribes to invalidation events
// and refetches.
//
// Why a service and not direct Store calls:
//   - UI needs aggregated queries (run summary, span stats) not in Store
//   - Avoid re-reading JSONL on every keystroke
//   - Centralize projection logic (now in V2 @ziner/trace/projections)
//
// Phase 6 refactor: the projection logic has been moved to
// `@ziner/trace/projections`. This file is now a thin caching
// + invalidation wrapper over those V2 functions.

import type { Store, RunQuery, SpanQuery } from '../infra/storage';
import type {
  AgentRun,
  AgentSpan,
  Evaluation,
  Baseline,
  PromptCandidate,
  PromptVariant,
  VariantStats,
  EvaluationAggregate,
  EvaluationDelta,
} from '../contracts';
import {
  listRunSummaries as v2ListRunSummaries,
  listSpanNodes as v2ListSpanNodes,
  readRunEvents as v2ReadRunEvents,
  computeScoreTrend as v2ComputeScoreTrend,
  buildBaseline as v2BuildBaseline,
  diffBaseline as v2DiffBaseline,
  projectVariantStats as v2ProjectVariantStats,
  listToolUsage as v2ListToolUsage,
  listSkillUsage as v2ListSkillUsage,
  type RunSummary,
  type SpanNode,
  type SpanEventLite,
} from '@ziner/trace';

export type { RunSummary, SpanNode, SpanEventLite };

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

  // ── Queries (cached, delegated to V2 projections) ──────────────────

  /** List Runs as lightweight summaries. */
  async listRuns(q: RunQuery = {}): Promise<RunSummary[]> {
    const key = `runs:${JSON.stringify(q)}`;
    const hit = this._cache.get(key) as RunSummary[] | undefined;
    if (hit) return hit;
    const out = await v2ListRunSummaries(this.store, q);
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
    const out = await v2ListSpanNodes(this.store, runId);
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
    const out = await v2ReadRunEvents(this.store, runId);
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
  } = {}): Promise<Evaluation[]> {
    const key = `evals:${q.benchmarkId ?? '*'}:${q.pass ?? '*'}:${q.limit ?? 200}`;
    const cached = this._cache.get(key);
    if (cached) return cached as Evaluation[];
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
   * The `limit` is applied to the store query; the V2 function returns
   * the full sorted trend; callers may slice for display.
   */
  async scoreTrend(limit = 50): Promise<Array<{ timestamp: number; total: number; pass: boolean }>> {
    const key = `trend:${limit}`;
    const cached = this._cache.get(key);
    if (cached) return cached as Array<{ timestamp: number; total: number; pass: boolean }>;
    const evals = await this.store.evals.list({ limit });
    const out = v2ComputeScoreTrend(evals);
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
    const baseline = v2BuildBaseline({
      benchmarkId: args.benchmarkId,
      name: args.name,
      description: args.description,
      evaluations: evals,
    });
    await this.store.baselines.upsert(baseline);
    this.invalidate(`baselines:${args.benchmarkId}`, `baseline:${baseline.id}`);
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
      return v2DiffBaseline({ baseline: undefined, currentList: [] });
    }
    const since = baselineRec.createdAt;
    const currentList = await this.store.evals.list({
      benchmarkId: baselineRec.benchmarkId,
      fromTs: since,
      limit: args.recentLimit ?? 200,
    });
    return v2DiffBaseline({ baseline: baselineRec, currentList });
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
    const [bm, agent] = c.id.split(':');
    // Best-effort: load runs matching any variant tag. The V2 projection
    // computes per-variant aggregates from this list.
    const variantTagPrefix = 'variant:';
    const tagFilter = c.variants.map((v) => `${variantTagPrefix}${v.id}`);
    const runs = tagFilter.length
      ? await this.store.runs.list({ tagsAny: tagFilter, limit: 2000 })
      : [];
    void bm; void agent;
    return v2ProjectVariantStats({ candidate: c, runs });
  }

  // ── Optimizer stats (Phase 5) ──────────────────────────────────────

  /**
   * Per-tool usage + success rate. Reads all spans of `type=tool`.
   * Used by the "Tool Optimizer" section of the Evolution panel.
   */
  async toolUsage(windowMs = 7 * 24 * 60 * 60 * 1000): Promise<
    Array<{ name: string; calls: number; ok: number; error: number; successRate: number; avgDurationMs: number }>
  > {
    const key = `toolUsage:${windowMs}`;
    const cached = this._cache.get(key);
    if (cached) return cached as Array<{ name: string; calls: number; ok: number; error: number; successRate: number; avgDurationMs: number }>;
    const out = await v2ListToolUsage(this.store, windowMs);
    this._cache.set(key, out);
    return out;
  }

  /**
   * Per-skill hit rate and success rate. Reads spans of `type=skill`.
   * Used by the "Skill Optimizer" section.
   */
  async skillUsage(windowMs = 7 * 24 * 60 * 60 * 1000): Promise<
    Array<{ name: string; hits: number; successRate: number }>
  > {
    const key = `skillUsage:${windowMs}`;
    const cached = this._cache.get(key);
    if (cached) return cached as Array<{ name: string; hits: number; successRate: number }>;
    const out = await v2ListSkillUsage(this.store, windowMs);
    this._cache.set(key, out);
    return out;
  }
}
