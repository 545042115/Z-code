// Plan Executor (sequential) — generic mechanism for running a Plan.
//
// This is the framework part of "planning". It is intentionally
// agent-agnostic: it takes a Plan and a per-step runner function
// and runs steps in order, respecting `dependsOn` semantics when
// present (sequential executor runs them in the given order).
//
// Coding/Browser/Research agent-specific planners build their own
// `Plan` and pass a `StepHandler` here. The framework just orchestrates.
//
// Phase 6A: this is the minimal V2 framework. Future work: better
// parallelism, retries, rollback hooks (per ADR 4.2).

import type { Plan, PlanStep, PlanResult, TaskContext, ErrorRef } from '@ziner/contracts';
import { classify } from '@ziner/infra-errors';

/**
 * A StepHandler is the per-step implementation. It returns the step's
 * result (or throws). The framework catches errors and marks the step
 * accordingly.
 */
export type StepHandler = (step: PlanStep, ctx: TaskContext) => Promise<unknown>;

export interface SequentialExecutorOptions {
  /** Stop the plan on first error. Default true. */
  stopOnError?: boolean;
}

/**
 * Execute a Plan sequentially. Each step is awaited; on error the
 * executor either stops or continues based on `stopOnError`.
 */
export async function executeSequential(
  plan: Plan,
  ctx: TaskContext,
  handler: StepHandler,
  opts: SequentialExecutorOptions = {},
): Promise<PlanResult> {
  const stopOnError = opts.stopOnError !== false;
  const t0 = Date.now();
  let firstError: ErrorRef | undefined;

  for (const step of plan.steps) {
    if (firstError && stopOnError) {
      step.status = 'skipped';
      continue;
    }
    step.status = 'running';
    const ts = Date.now();
    try {
      const r = await handler(step, ctx);
      step.result = r;
      step.status = 'ok';
    } catch (e) {
      const err = classify(e);
      step.error = err;
      step.status = 'error';
      firstError = firstError ?? err;
    }
    step.durationMs = Date.now() - ts;
  }

  return {
    ok: !firstError,
    steps: plan.steps,
    error: firstError,
    totalDurationMs: Date.now() - t0,
  };
}
