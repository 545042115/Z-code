// RunTracker — manages the lifecycle of a single AgentRun.
//
// A Run is identified by id + traceId. The tracker:
//   - generates ids on start
//   - holds the active Run record
//   - starts child Spans (nestable)
//   - persists Run / Span to the Store on every mutation
//   - writes SpanEvent stream to the Store's `traceStream` interface
//
// Lifecycle:
//   const tracker = runTracker.start({ task, model, sessionId });
//   const span = tracker.startSpan({ name: 'tool:edit_file', type: 'tool' });
//   span.setOutput({ ok: true });
//   span.end();
//   await tracker.finish('success');

import { randomUUID } from 'crypto';
import { promises as fsp, mkdirSync, existsSync, appendFileSync } from 'fs';
import { join, dirname } from 'path';
import { Span, type SpanOptions } from './span';
import type { Store } from '../infra/storage';
import { classify } from '../infra/errors';
import { computeCost } from '../infra/cost';
import { computeDuration } from '../contracts';
import type { AgentRun, ModelRef, RunStatus, ErrorRef, SpanEvent } from '../contracts';

export interface RunStartOptions {
  task: string;
  model: ModelRef;
  sessionId: string;
  userId?: string;
  tags?: string[];
  metadata?: Record<string, string | number | boolean | null>;
}

export interface RunFinishOptions {
  status?: RunStatus;
  error?: ErrorRef;
}

export class RunTracker {
  private _run: AgentRun;
  private _spans = new Map<string, Span>();
  private _store: Store;
  private _eventFile: string;
  private _closed = false;
  /** Tail of the write chain; new writes are appended after it settles. */
  private _writeChain: Promise<void> = Promise.resolve();
  /** Span writes enqueued since last flush (for the flush() waiter). */
  private _writeCount = 0;

  constructor(run: AgentRun, store: Store, eventFile: string) {
    this._run = run;
    this._store = store;
    this._eventFile = eventFile;
  }

  // ── Accessors ───────────────────────────────────────────────────────

  get id(): string { return this._run.id; }
  get traceId(): string { return this._run.traceId; }
  get run(): AgentRun { return this._run; }

  // ── Lifecycle ───────────────────────────────────────────────────────

  /** Update the Run's tags / metadata mid-flight. */
  async updateMeta(set: Partial<Pick<AgentRun, 'tags' | 'metadata'>>): Promise<void> {
    if (set.tags) this._run.tags = [...this._run.tags, ...set.tags];
    if (set.metadata) this._run.metadata = { ...this._run.metadata, ...set.metadata };
    await this._store.runs.update(this._run.id, {
      tags: this._run.tags,
      metadata: this._run.metadata,
    });
  }

  /** Increment aggregate token / cost counters. */
  async addUsage(tokensIn: number, tokensOut: number): Promise<void> {
    const cost = computeCost(this._run.model, tokensIn, tokensOut);
    this._run.totalTokensIn += tokensIn;
    this._run.totalTokensOut += tokensOut;
    this._run.totalCostUsd += cost;
    await this._store.runs.update(this._run.id, {
      totalTokensIn: this._run.totalTokensIn,
      totalTokensOut: this._run.totalTokensOut,
      totalCostUsd: this._run.totalCostUsd,
    });
  }

  /** Start a new Span as a child of `parent` (or root if omitted). */
  startSpan(opts: Omit<SpanOptions, 'runId' | 'traceId'> & { parentSpanId?: string }): Span {
    const span = new Span({
      ...opts,
      runId: this._run.id,
      traceId: this._run.traceId,
      parentSpanId: opts.parentSpanId,
    });
    this._spans.set(span.id, span);
    // Persist initial record + subscribe to mutations.
    // NOTE: we pass a thunk so the write starts only when the chain
    // reaches it — this guarantees FIFO ordering and that the latest
    // state is the last one written.
    this._enqueue(() => this._persistSpan(span));
    span._subscribe((s) => this._enqueue(() => this._persistSpan(s)));
    return span;
  }

  /** Finish the Run. Persists final state. */
  async finish(opts: RunFinishOptions = {}): Promise<void> {
    if (this._closed) return;
    // End any un-ended spans
    for (const s of this._spans.values()) {
      if (!s.isFinished()) s.end();
    }
    await this.flush();
    this._run.endTime = Date.now();
    this._run.duration = computeDuration(this._run.startTime, this._run.endTime);
    this._run.status = opts.status ?? (this._run.error ? 'failed' : 'success');
    if (opts.error) this._run.error = opts.error;
    await this._store.runs.update(this._run.id, {
      endTime: this._run.endTime,
      duration: this._run.duration,
      status: this._run.status,
      error: this._run.error,
    });
    this._closed = true;
    // Notify the manager that this Run is done so a new one can start.
    this._onFinish?.();
  }

  /** Internal: set by TraceManager to clear its `_active` slot. */
  _onFinish?: () => void;

  /** Wait for all queued writes to complete. Call before reading state. */
  async flush(): Promise<void> {
    if (this._writeCount === 0) return;
    // Wait for the tail of the write chain.
    await this._writeChain;
  }

  // ── Internals ───────────────────────────────────────────────────────

  private _enqueue(work: () => Promise<void>): void {
    this._writeCount++;
    this._writeChain = this._writeChain
      .then(() => work())
      .catch(() => {
        // Don't let a single write fail the chain; swallow for now.
      })
      .finally(() => this._writeCount--);
  }

  private async _persistSpan(s: Span): Promise<void> {
    await this._store.spans.insert(s.toRecord());
  }

  /** Append a SpanEvent to the JSONL stream file. */
  appendEvent(ev: SpanEvent): void {
    if (!existsSync(dirname(this._eventFile))) {
      mkdirSync(dirname(this._eventFile), { recursive: true });
    }
    appendFileSync(this._eventFile, JSON.stringify(ev) + '\n', 'utf8');
  }
}

// ── Factory ───────────────────────────────────────────────────────────

export interface TraceManagerOptions {
  store: Store;
  /** Root dir for trace event streams; usually `<store.rootDir>/traces` */
  tracesDir: string;
}

export class TraceManager {
  private _active: RunTracker | null = null;

  constructor(public readonly opts: TraceManagerOptions) {
    this._query = new (require('../trace-ui/query-service').QueryService)(opts.store);
  }

  /** Lazily-constructed QueryService over the configured Store. */
  private _query: import('../trace-ui/query-service').QueryService;
  getQueryService(): import('../trace-ui/query-service').QueryService {
    return this._query;
  }
  /** Injected by `getQueryService` if a different one is needed. */
  setQueryService(q: import('../trace-ui/query-service').QueryService): void {
    this._query = q;
  }

  /** Start a new Run. The returned tracker is the single source of truth. */
  async startRun(opts: RunStartOptions): Promise<RunTracker> {
    if (this._active) {
      throw new Error('a Run is already active; finish it before starting a new one');
    }
    const id = randomUUID();
    const traceId = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '').slice(0, 0);
    // W3C traceId is 16 bytes (32 hex chars). Use UUID×2 for the right length.
    const trace = (randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '')).slice(0, 32);

    const run: AgentRun = {
      id,
      traceId: trace,
      sessionId: opts.sessionId,
      userId: opts.userId,
      task: opts.task,
      model: opts.model,
      startTime: Date.now(),
      status: 'running',
      totalTokensIn: 0,
      totalTokensOut: 0,
      totalCostUsd: 0,
      tags: opts.tags ?? [],
      metadata: opts.metadata ?? {},
    };
    await this._ensureTracesDir();
    await this.opts.store.runs.insert(run);
    const eventFile = join(this.opts.tracesDir, `${id}.jsonl`);
    const tracker = new RunTracker(run, this.opts.store, eventFile);
    tracker._onFinish = () => { this._active = null; };
    this._active = tracker;
    return tracker;
  }

  /** Get the currently active Run tracker (or null). */
  active(): RunTracker | null { return this._active; }

  /** Helper: classify an unknown error into a structured ErrorRef. */
  static errorOf(err: unknown): ErrorRef {
    return classify(err);
  }

  private async _ensureTracesDir(): Promise<void> {
    if (!existsSync(this.opts.tracesDir)) {
      await fsp.mkdir(this.opts.tracesDir, { recursive: true });
    }
  }
}
