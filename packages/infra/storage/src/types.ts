// Store Contract — the interface every storage backend implements.
//
// Per ADR 0002, the production target is SQLite + JSONL dual-write.
// For VS Code extensions, however, native SQLite modules are awkward,
// so the Phase 0 default backend (`FileStore` in jsonl-store.ts) uses
// JSONL append-only logs. The interface is identical, so swapping
// to SQLite later is a single-file change.
//
// Read path: scans append-only logs, builds an in-memory index per
// process lifetime. Acceptable because trace data volume per process
// is small (< 100k records typical).

import type {
  AgentRun,
  AgentSpan,
  SpanEvent,
  Benchmark,
  Evaluation,
  Baseline,
  PromptCandidate,
  RunStatus,
  SpanStatus,
} from '@z-assistant/contracts';

// ── Common Query ──────────────────────────────────────────────────────

export interface ListQuery {
  /** Max records to return; default 200 */
  limit?: number;
  /** Skip first N records; default 0 */
  offset?: number;
  /** Sort order; default 'desc' for time-based fields */
  order?: 'asc' | 'desc';
}

// ── RunRepo ───────────────────────────────────────────────────────────

export interface RunQuery extends ListQuery {
  status?: RunStatus | RunStatus[];
  sessionId?: string;
  /** Inclusive lower bound on startTime (epoch ms) */
  fromTs?: number;
  /** Exclusive upper bound on startTime (epoch ms) */
  toTs?: number;
  /** Filter by tags (any match) */
  tagsAny?: string[];
}

export interface RunRepo {
  /** Insert a new Run. Throws if a Run with the same id already exists. */
  insert(run: AgentRun): Promise<void>;
  /** Get a Run by id. */
  get(id: string): Promise<AgentRun | undefined>;
  /** Patch fields on a Run. `set` is a shallow merge. */
  update(id: string, set: Partial<AgentRun>): Promise<void>;
  /** List Runs matching the query. */
  list(q?: RunQuery): Promise<AgentRun[]>;
  /** Count Runs matching the query. */
  count(q?: RunQuery): Promise<number>;
  /** Permanently delete a Run and all its Spans/Events. */
  delete(id: string): Promise<void>;
}

// ── SpanRepo ──────────────────────────────────────────────────────────

export interface SpanQuery extends ListQuery {
  runId?: string | string[];
  type?: AgentSpan['type'] | AgentSpan['type'][];
  status?: SpanStatus | SpanStatus[];
  agent?: string;
  fromTs?: number;
  toTs?: number;
}

export interface SpanRepo {
  insert(span: AgentSpan): Promise<void>;
  get(id: string): Promise<AgentSpan | undefined>;
  update(id: string, set: Partial<AgentSpan>): Promise<void>;
  listByRun(runId: string, q?: Omit<SpanQuery, 'runId'>): Promise<AgentSpan[]>;
  list(q?: SpanQuery): Promise<AgentSpan[]>;
  count(q?: SpanQuery): Promise<number>;
  /** Delete all Spans belonging to a Run. */
  deleteByRun(runId: string): Promise<number>;
}

// ── EvalRepo ──────────────────────────────────────────────────────────

export interface EvalQuery extends ListQuery {
  runId?: string;
  benchmarkId?: string;
  pass?: boolean;
  fromTs?: number;
  toTs?: number;
}

export interface EvalRepo {
  insert(ev: Evaluation): Promise<void>;
  get(id: string): Promise<Evaluation | undefined>;
  list(q?: EvalQuery): Promise<Evaluation[]>;
  count(q?: EvalQuery): Promise<number>;
  /** Aggregated pass rate over the given window. */
  passRate(q?: EvalQuery): Promise<number>;
}

// ── BenchmarkRepo ─────────────────────────────────────────────────────

export interface BenchmarkQuery extends ListQuery {
  difficulty?: Benchmark['difficulty'] | Benchmark['difficulty'][];
  tag?: string;
  source?: string;
}

export interface BenchmarkRepo {
  insert(b: Benchmark): Promise<void>;
  upsert(b: Benchmark): Promise<void>;
  get(id: string): Promise<Benchmark | undefined>;
  list(q?: BenchmarkQuery): Promise<Benchmark[]>;
  count(q?: BenchmarkQuery): Promise<number>;
  delete(id: string): Promise<void>;
}

// ── BaselineRepo ─────────────────────────────────────────────────────

export interface BaselineQuery extends ListQuery {
  benchmarkId?: string;
  name?: string;
}

/**
 * Persists frozen Evaluation snapshots used as the reference point
 * for "did this change make us better or worse?" comparisons.
 *
 * Baselines are append-only. A new "release" baseline is created by
 * snapshotting the current set of Evaluations for a Benchmark.
 */
export interface BaselineRepo {
  insert(b: Baseline): Promise<void>;
  /** Replace a Baseline with the same id. */
  upsert(b: Baseline): Promise<void>;
  get(id: string): Promise<Baseline | undefined>;
  list(q?: BaselineQuery): Promise<Baseline[]>;
  count(q?: BaselineQuery): Promise<number>;
  delete(id: string): Promise<void>;
}

// ── PromptCandidateRepo (Phase 5) ────────────────────────────────────

export interface PromptCandidateQuery extends ListQuery {
  agentName?: string;
  name?: string;
}

/**
 * Persists PromptCandidate records (one agent's prompt + variants).
 * The Phase 5 Evolution panel reads/writes this for A/B testing.
 */
export interface PromptCandidateRepo {
  upsert(c: PromptCandidate): Promise<void>;
  get(id: string): Promise<PromptCandidate | undefined>;
  list(q?: PromptCandidateQuery): Promise<PromptCandidate[]>;
  count(q?: PromptCandidateQuery): Promise<number>;
  delete(id: string): Promise<void>;
}

// ── Store ─────────────────────────────────────────────────────────────

/**
 * The unified storage facade. Consumers depend on this interface,
 * not on a specific backend.
 *
 *   const store = createFileStore({ rootDir: ctx.globalStorageUri.fsPath });
 *   await store.runs.insert(run);
 *   const list = await store.spans.listByRun(run.id);
 *
 * The `traceStream` method returns an async iterable of `SpanEvent`s
 * for a given Run. For completed Runs, all events are read once.
 * For in-flight Runs, new events appear as they are written.
 */
export interface Store {
  readonly runs: RunRepo;
  readonly spans: SpanRepo;
  readonly evals: EvalRepo;
  readonly benchmarks: BenchmarkRepo;
  readonly baselines: BaselineRepo;
  readonly candidates: PromptCandidateRepo;
  /** Stream of SpanEvents for a Run, in ts order. */
  traceStream(runId: string): AsyncIterable<SpanEvent>;
  /** Flush any pending writes to disk. Optional; default is no-op. */
  flush?(): Promise<void>;
  /** Close the store and release file handles. */
  close(): Promise<void>;
}
