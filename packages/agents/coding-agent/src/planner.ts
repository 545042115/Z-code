// CodingPlanner — V2 `IPlanner` adapter backed by V1's
// `extensions/coding-agent/src/planner/planner.ts`.
//
// Phase 6A: skeleton. R7 wires the real V1 Planner (which uses
// plan-templates/coding.ts) behind this. The shape is fixed:
// implements V2 `IPlanner` so V2 Apps / Orchestrator can build
// and execute Coding plans.

import type {
  IPlanner,
  Plan,
  PlanResult,
  TaskContext,
} from '@z-assistant/contracts';

export interface CodingPlannerOptions {
  /** Optional override; used by tests. */
  impl?: IPlanner;
}

export class CodingPlanner implements IPlanner {
  readonly name = 'coding-planner';

  constructor(private readonly opts: CodingPlannerOptions = {}) {}

  async buildPlan(ctx: TaskContext): Promise<Plan> {
    if (this.opts.impl) return this.opts.impl.buildPlan(ctx);
    // Phase 6A stub — R7 delegates to V1 `Planner.plan()`
    return {
      id: 'stub-plan',
      name: 'stub',
      steps: [],
      metadata: { source: 'coding-planner', phase: '6A' },
    };
  }

  async execute(plan: Plan, ctx: TaskContext): Promise<PlanResult> {
    if (this.opts.impl) return this.opts.impl.execute(plan, ctx);
    // Phase 6A stub — R7 delegates to V1 `Planner.executePlan()`
    return {
      ok: false,
      steps: plan.steps,
      totalDurationMs: 0,
      error: {
        code: '3001',
        message: 'CodingPlanner is a Phase 6A stub; wire V1 planner in R7.',
      },
    };
  }
}
