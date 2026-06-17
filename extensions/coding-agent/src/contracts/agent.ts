// Agent Contracts — interfaces for single- and multi-agent execution (Phase 2).
//
// `IAgent` is the smallest unit the Orchestrator can dispatch. Multiple
// concrete agents (Planner / Research / Coding / Review / Test / ...)
// implement this interface and are registered in `agent-registry`.
//
// `TaskContext` is the immutable per-dispatch envelope (task + shared state +
// budget). `SharedState` is the mutable blackboard agents read/write.
//
// Budget is enforced by infra/cost; an agent exceeding its share should
// throw `BudgetExceededError` (see infra/cost/budget.ts).

import type { ErrorRef } from './run';

// ── ModelSpec ─────────────────────────────────────────────────────────

/** LLM binding for an agent or prompt. */
export interface ModelSpec {
  /** Provider id, e.g. "openai", "sglang", "deepseek" */
  provider: string;
  /** Model name, e.g. "gpt-4o", "deepseek-chat" */
  name: string;
  /** 0-1, default 0.1 for coding tasks */
  temperature?: number;
  /** Max output tokens; falls back to global default */
  maxTokens?: number;
  /** Top-p; optional */
  topP?: number;
}

// ── SharedState (Blackboard) ──────────────────────────────────────────

/**
 * Multi-agent shared blackboard. Agents read inputs from here and write
 * artifacts back. Backed by an event-emitter KV store; see infra/agent
 * implementation in Phase 2.
 *
 * Notes:
 * - Keys are arbitrary strings; recommend `domain.entity` (e.g. "plan.dag").
 * - Values are JSON-serializable. Large blobs should be stored as URIs.
 */
export interface SharedState {
  get<T = unknown>(key: string): T | undefined;
  /** Set a value. Optional `writer` records which agent wrote it. */
  set(key: string, value: unknown, writer?: string): void;
  has(key: string): boolean;
  delete(key: string): boolean;
  /** Atomic increment; creates with `by` if missing. Returns the new value. */
  incr(key: string, by?: number, writer?: string): number;
  /** Number of keys currently stored. */
  size(): number;
  /** Snapshot of all keys + versions; for persistence/restore. */
  snapshot(): Record<string, { value: unknown; version: number; updatedAt: number; writer?: string }>;
  /** Subscribe to changes of a single key. Returns an unsubscribe function. */
  subscribe(key: string, fn: (value: unknown, version: number) => void): () => void;
  /** Subscribe to all changes. */
  subscribeAny(fn: (key: string, value: unknown, version: number) => void): () => void;
}

// ── Budget ────────────────────────────────────────────────────────────

/** Remaining budget for the current dispatch. */
export interface Budget {
  tokensLeft: number;
  costLeftUsd: number;
  /** Wall-clock deadline (epoch ms); agents should respect it */
  deadlineMs?: number;
}

// ── TaskContext ───────────────────────────────────────────────────────

/**
 * Per-dispatch envelope. Passed to every IAgent.execute call.
 * Everything an agent needs (task, shared state, budget, trace context)
 * lives here so agents stay stateless w.r.t. the rest of the system.
 */
export interface TaskContext {
  /** Original user request (or sub-task after decomposition) */
  task: string;
  /** Default model for this dispatch */
  model: ModelSpec;
  /** Session id for the owning Run */
  sessionId: string;
  /** Optional user id */
  userId?: string;
  /** Shared multi-agent blackboard */
  sharedState: SharedState;
  /** Owning Run id; for emitting Spans */
  parentRunId: string;
  /** Owning Trace id; for emitting Spans */
  traceId: string;
  /** Remaining budget; agents MUST check before expensive calls */
  budget: Budget;
  /** Optional upstream agent name; useful for context in logs */
  invokedBy?: string;
  /** Cancellation signal; agents should poll `ctx.signal` */
  signal?: AbortSignal;
  /** Free-form metadata; not interpreted by the framework */
  metadata?: Record<string, string | number | boolean | null>;
}

// ── AgentResult ───────────────────────────────────────────────────────

/** Result of a single agent dispatch. */
export interface AgentResult {
  ok: boolean;
  /** Primary output; shape depends on the agent */
  output?: unknown;
  /** Named artifacts to publish to SharedState */
  artifacts?: Record<string, unknown>;
  /** Failure reason; required when ok === false */
  error?: ErrorRef;
  /** Per-dispatch metrics; aggregated into the parent Span */
  metrics?: AgentMetrics;
}

export interface AgentMetrics {
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  durationMs: number;
  /** Number of LLM calls made during this dispatch */
  llmCalls: number;
  /** Number of tool calls made during this dispatch */
  toolCalls: number;
}

// ── IAgent ────────────────────────────────────────────────────────────

/**
 * The contract every agent implements. The Orchestrator uses:
 * - `capabilities` for routing
 * - `dependencies` for DAG scheduling
 * - `modelPreference` to pick a ModelSpec
 * - `canHandle?` for soft routing (returns 0-1 score)
 * - `execute` for the actual work
 * - `rollback?` for compensating actions on upstream failure
 */
export interface IAgent {
  /** Stable unique name; used in registry and Spans */
  name: string;
  /** Human-readable role, e.g. "Code Reviewer" */
  role: string;
  /** Free-form capability tags, e.g. ["code.edit", "test.run", "refactor"] */
  capabilities: string[];
  /** Names of other agents whose outputs this one consumes */
  dependencies: string[];
  /** Preferred model; falls back to global default */
  modelPreference?: ModelSpec;

  /**
   * Soft routing score in [0, 1]. Optional; Orchestrator defaults to 0.5.
   * Used when multiple agents could handle a sub-task.
   */
  canHandle?(ctx: TaskContext): number | Promise<number>;

  /** Perform the work. MUST emit Spans for any LLM/tool calls. */
  execute(ctx: TaskContext): Promise<AgentResult>;

  /**
   * Compensate for partial work if a downstream agent fails.
   * Optional; default is a no-op. MUST be idempotent.
   */
  rollback?(ctx: TaskContext): Promise<void>;

  /**
   * Lightweight health check; Orchestrator may exclude unhealthy agents
   * from routing. Optional; default returns `{ ok: true }`.
   */
  health?(): Promise<AgentHealth>;
}

export interface AgentHealth {
  ok: boolean;
  /** Free-form reason when not ok, e.g. "rate_limited", "model_unreachable" */
  reason?: string;
  /** Last check timestamp (epoch ms) */
  checkedAt?: number;
}

// ── Helpers ───────────────────────────────────────────────────────────

/** Construct a successful AgentResult shorthand. */
export function ok(output: unknown, extras?: Partial<AgentResult>): AgentResult {
  return { ok: true, output, ...extras };
}

/** Construct a failed AgentResult shorthand. */
export function fail(code: string, message: string, extras?: Partial<AgentResult>): AgentResult {
  return { ok: false, error: { code, message }, ...extras };
}
