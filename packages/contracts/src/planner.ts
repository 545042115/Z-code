// Planner Contracts — the interface for any agent's Plan executor.
//
// `IPlanner` builds a `Plan` from a `TaskContext` and executes it
// step-by-step. The plan + step model is generic; concrete planners
// (Coding's plan-templates, Browser's DOM plan, Research's search
// plan) live in their own packages and implement this interface.
//
// Framework-level executors (sequential / DAG / parallel) live in
// `@ziner/runtime` and operate on these types.

import type { ErrorRef } from './run';
import type { TaskContext } from './agent';

// ── Plan step status ──────────────────────────────────────────────────

/**
 * Status of a single Plan step. `skipped` is used when an upstream
 * dependency failed and the step is unreachable.
 */
export type PlanStepStatus = 'pending' | 'running' | 'ok' | 'error' | 'skipped';

// ── PlanStep ──────────────────────────────────────────────────────────

export interface PlanStep {
  id: string;
  name: string;
  /** Optional dependency edges (other step ids this step waits on). */
  dependsOn?: string[];
  /** Optional: a description shown to the user. */
  description?: string;
  status: PlanStepStatus;
  /** Free-form per-step output (interpretation depends on the planner). */
  result?: unknown;
  /** Error when status === 'error'. */
  error?: ErrorRef;
  durationMs?: number;
}

// ── Plan ──────────────────────────────────────────────────────────────

export interface Plan {
  id: string;
  name: string;
  steps: PlanStep[];
  /** Optional metadata (e.g. source, owner agent). */
  metadata?: Record<string, string | number | boolean | null>;
}

// ── PlanResult ────────────────────────────────────────────────────────

export interface PlanResult {
  ok: boolean;
  steps: PlanStep[];
  error?: ErrorRef;
  totalDurationMs: number;
}

// ── IPlanner ──────────────────────────────────────────────────────────

/**
 * The framework-level planner interface. Concrete planners (Coding
 * Planner, Browser Planner, Research Planner) build a `Plan` from a
 * task and execute it. The framework layer (`@ziner/runtime`)
 * provides generic executors; the agent-specific planners live in
 * their own packages and implement this interface.
 */
export interface IPlanner {
  /** Stable name; used in registry and Spans. */
  name: string;
  /** Build a Plan for a given task without executing it. */
  buildPlan(ctx: TaskContext): Promise<Plan>;
  /** Execute a Plan, returning the final status + snapshots. */
  execute(plan: Plan, ctx: TaskContext): Promise<PlanResult>;
}
