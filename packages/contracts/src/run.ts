// Run / Span / Event Contracts — the data backbone of V2 observability.
//
// Every execution of the Agent (single-agent, multi-agent, harness, evolution)
// produces exactly one AgentRun, which is composed of nested AgentSpans.
// Spans emit SpanEvents as they execute; events are streamed via JSONL
// and spans are persisted to SQLite (see ADR 0002).
//
// Field naming follows OpenTelemetry semantic conventions for LLM/tool spans
// (see ADR 0003). The `attributes` bag carries OTel-style key/value pairs
// (e.g. `gen_ai.usage.input_tokens`); business-specific fields use the
// `z.*` namespace (e.g. `z.task.id`).

// ── Enums ─────────────────────────────────────────────────────────────

/** Lifecycle status of an AgentRun. */
export type RunStatus = 'running' | 'success' | 'failed' | 'cancelled';

/** Lifecycle status of a single Span. */
export type SpanStatus = 'ok' | 'error' | 'cancelled';

/**
 * Discriminator for what kind of work a Span represents.
 * `routing` / `memory` / `skill` were added in V2 to support
 * multi-agent orchestration (Phase 2) and skill/learning layers (Phase 5).
 */
export type SpanType =
  | 'llm'
  | 'tool'
  | 'planner'
  | 'verify'
  | 'reflection'
  | 'routing'
  | 'memory'
  | 'skill'
  | 'agent';

// ── SpanEvent ─────────────────────────────────────────────────────────

/**
 * A single point-in-time event emitted by a Span.
 * Stored append-only in the JSONL trace stream (see ADR 0002).
 */
export interface SpanEvent {
  /** Epoch milliseconds */
  ts: number;
  /** Event name, e.g. "stream.chunk", "tool.start", "llm.choice" */
  name: string;
  /** OTel-style attributes */
  attributes?: Record<string, string | number | boolean | null>;
}

// ── AgentRun ──────────────────────────────────────────────────────────

/**
 * Top-level execution record for a single user task.
 * One Run = one task. Multi-agent / parallel work nests as Spans.
 */
export interface AgentRun {
  /** Run-local unique id (uuid v4 recommended) */
  id: string;
  /** W3C trace id, 16-byte hex; shared across processes (Phase 0) */
  traceId: string;
  /** Multi-turn session id; groups Runs of the same conversation */
  sessionId: string;
  /** Optional user id; reserved even in single-user desktop for future sync */
  userId?: string;

  /** Original user request text */
  task: string;
  /** Model actually used (after routing/fallback) */
  model: ModelRef;

  /** Epoch milliseconds */
  startTime: number;
  endTime?: number;
  /** endTime - startTime; recomputed at finalize */
  duration?: number;

  status: RunStatus;

  /** Aggregated token usage across all child Spans */
  totalTokensIn: number;
  totalTokensOut: number;
  /** Aggregated cost in USD; computed from pricing table (see infra/cost) */
  totalCostUsd: number;

  /** Free-form tags for filtering in Dashboard (e.g. ["bench:swe-bench", "agent:planner"]) */
  tags: string[];
  /** OTel-style structured metadata */
  metadata: Record<string, string | number | boolean | null>;

  /** Top-level error; child errors live on individual Spans */
  error?: ErrorRef;
}

/** Compact model reference. */
export interface ModelRef {
  provider: string;
  name: string;
}

/** Structured error reference (mapped from infra/errors/error-codes.ts). */
export interface ErrorRef {
  /** Numeric error code; see SECURITY.md §10 for the canonical ranges */
  code: string;
  message: string;
  /** Stack trace; truncated in non-debug builds */
  stack?: string;
}

// ── AgentSpan ─────────────────────────────────────────────────────────

/**
 * A single unit of work within a Run. Spans form a tree via `parentSpanId`.
 * Leaf Spans are typically `tool` or `llm`; internal Spans are `planner`,
 * `routing`, `verify`, `reflection`, `memory`, `skill`.
 */
export interface AgentSpan {
  /** Span-local unique id */
  id: string;
  /** Redundant copy of AgentRun.traceId for query convenience */
  traceId: string;
  /** Owning Run id */
  runId: string;
  /** Parent Span id; undefined for root Spans */
  parentSpanId?: string;

  /** Human-readable name, e.g. "tool:edit_file", "planner:decompose" */
  name: string;
  type: SpanType;
  /** Which agent produced this Span; set in Phase 2 */
  agent?: string;

  startTime: number;
  endTime?: number;
  /** endTime - startTime */
  duration?: number;

  status: SpanStatus;

  /** Tool/LLM inputs; capped at 32KB by infra/permission */
  input?: unknown;
  /** Tool/LLM outputs; capped at 32KB */
  output?: unknown;

  /**
   * OTel-style attributes. Required keys depend on `type`:
   * - llm: gen_ai.system, gen_ai.request.model, gen_ai.usage.input_tokens, ...
   * - tool: tool.name, tool.call.id, tool.call.arguments
   * See ADR 0003 for the full schema.
   */
  attributes: Record<string, string | number | boolean | null>;
  /** Streamed events; persisted to JSONL (see ADR 0002) */
  events: SpanEvent[];

  /** Token usage; only set for `llm` Spans */
  tokensIn?: number;
  tokensOut?: number;
  /** Cost in USD; computed from infra/cost/pricing */
  costUsd?: number;

  /** Set when status === "error" */
  error?: ErrorRef;
}

// ── Helpers ───────────────────────────────────────────────────────────

/** Type guard for terminal Run status. */
export function isRunFinished(status: RunStatus): boolean {
  return status === 'success' || status === 'failed' || status === 'cancelled';
}

/** Type guard for terminal Span status. */
export function isSpanFinished(status: SpanStatus): boolean {
  return status === 'ok' || status === 'error' || status === 'cancelled';
}

/**
 * Compute duration in milliseconds; returns undefined if not finished.
 * Use this rather than hand-computing to keep semantics consistent.
 */
export function computeDuration(
  startTime: number,
  endTime: number | undefined
): number | undefined {
  if (endTime === undefined) return undefined;
  return Math.max(0, endTime - startTime);
}
