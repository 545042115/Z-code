// Span — a single unit of work in a Run.
//
// Span is a thin, ergonomic wrapper around the `AgentSpan` contract
// from `@ziner/contracts`. It handles:
//   - lifecycle (start, end, fail, cancel)
//   - event appending (streamed to JSONL via the manager)
//   - parent/child nesting
//   - attribute & metric accumulation
//
// Span is intentionally NOT a class that mutates a store. Persistence
// is the manager's job. This keeps Spans testable in isolation.

import { randomUUID } from 'crypto';
import type {
  AgentSpan,
  SpanEvent,
  SpanType,
  SpanStatus,
  ErrorRef,
} from '@ziner/contracts';

export interface SpanOptions {
  runId: string;
  traceId: string;
  name: string;
  type: SpanType;
  parentSpanId?: string;
  agent?: string;
  /** Initial input; can be updated via `setInput` before end. */
  input?: unknown;
  /** Initial attributes. */
  attributes?: Record<string, string | number | boolean | null>;
}

export class Span {
  readonly id: string;
  readonly runId: string;
  readonly traceId: string;
  readonly name: string;
  readonly type: SpanType;
  readonly parentSpanId?: string;
  readonly agent?: string;
  readonly startTime: number;

  private _endTime?: number;
  private _status: SpanStatus = 'ok';
  private _input?: unknown;
  private _output?: unknown;
  private _error?: ErrorRef;
  private _events: SpanEvent[] = [];
  private _attributes: Record<string, string | number | boolean | null>;
  private _tokensIn = 0;
  private _tokensOut = 0;
  private _costUsd = 0;

  /** Listener notified on every mutation (the manager subscribes). */
  private _onUpdate?: (s: Span) => void;

  constructor(opts: SpanOptions) {
    this.id = randomUUID();
    this.runId = opts.runId;
    this.traceId = opts.traceId;
    this.name = opts.name;
    this.type = opts.type;
    this.parentSpanId = opts.parentSpanId;
    this.agent = opts.agent;
    this.startTime = Date.now();
    this._input = opts.input;
    this._attributes = { ...(opts.attributes ?? {}) };
  }

  /** Internal: subscribe to mutations; returns the unsubscribe fn. */
  _subscribe(fn: (s: Span) => void): () => void {
    this._onUpdate = fn;
    return () => { this._onUpdate = undefined; };
  }

  setInput(v: unknown): this { this._input = v; this._emit(); return this; }
  setOutput(v: unknown): this { this._output = v; this._emit(); return this; }
  setAttribute(k: string, v: string | number | boolean | null): this {
    this._attributes[k] = v;
    this._emit();
    return this;
  }

  /** Append a streaming event. */
  addEvent(name: string, attributes?: SpanEvent['attributes']): this {
    this._events.push({ ts: Date.now(), name, attributes });
    this._emit();
    return this;
  }

  /** Add billable token usage. */
  addTokens(tokensIn: number, tokensOut: number, costUsd: number): this {
    this._tokensIn += tokensIn;
    this._tokensOut += tokensOut;
    this._costUsd += costUsd;
    this._emit();
    return this;
  }

  /** Mark the Span as failed. */
  fail(err: ErrorRef): this {
    this._status = 'error';
    this._error = err;
    this._emit();
    return this;
  }

  /** Mark the Span as cancelled. */
  cancel(): this {
    this._status = 'cancelled';
    this._emit();
    return this;
  }

  /** End the Span. Idempotent. */
  end(): void {
    if (this._endTime === undefined) {
      this._endTime = Date.now();
      this._emit();
    }
  }

  /** True when end() has been called. */
  isFinished(): boolean {
    return this._endTime !== undefined;
  }

  /** Serialize to a stable AgentSpan record. */
  toRecord(): AgentSpan {
    return {
      id: this.id,
      traceId: this.traceId,
      runId: this.runId,
      parentSpanId: this.parentSpanId,
      name: this.name,
      type: this.type,
      agent: this.agent,
      startTime: this.startTime,
      endTime: this._endTime,
      duration: this._endTime !== undefined ? this._endTime - this.startTime : undefined,
      status: this._status,
      input: this._input,
      output: this._output,
      attributes: { ...this._attributes },
      events: [...this._events],
      tokensIn: this._tokensIn || undefined,
      tokensOut: this._tokensOut || undefined,
      costUsd: this._costUsd > 0 ? this._costUsd : (this._tokensIn > 0 || this._tokensOut > 0 ? 0 : undefined),
      error: this._error,
    };
  }

  private _emit(): void {
    this._onUpdate?.(this);
  }
}
