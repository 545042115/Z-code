// Plan Executor (DAG) — generic mechanism for running a Plan respecting
// `dependsOn` edges with parallel-safe waves.
//
// Builds topological waves: a step is in wave N+1 iff all its deps are
// in waves <= N. Steps within the same wave run concurrently via
// Promise.all. The executor stops on first wave that has any error
// (with `stopOnError`) and skips remaining waves.
//
// Phase 6A: minimal V2 framework. Coding/Browser/Research agent-specific
// planners wrap this in their own package and supply a StepHandler.

import type { Plan, PlanStep, PlanResult, TaskContext, ErrorRef } from '@ziner/contracts';
import { classify } from '@ziner/infra-errors';
import type { StepHandler } from './sequential-executor';

export interface DagExecutorOptions {
  stopOnError?: boolean;
  /** Maximum number of steps per wave. Default unlimited. */
  maxWaveSize?: number;
}

/**
 * Build waves from a Plan's `dependsOn` edges. Returns a list of waves;
 * each wave is a list of step ids that can run in parallel. Returns
 * an empty array if a cycle is detected.
 */
export function buildWaves(plan: Plan): string[][] {
  const byId = new Map<string, PlanStep>();
  for (const s of plan.steps) byId.set(s.id, s);

  const remaining = new Set(plan.steps.map((s) => s.id));
  const placed = new Set<string>();
  const waves: string[][] = [];

  while (remaining.size > 0) {
    const wave: string[] = [];
    for (const id of remaining) {
      const step = byId.get(id)!;
      const deps = step.dependsOn ?? [];
      if (deps.every((d) => !remaining.has(d))) wave.push(id);
    }
    if (wave.length === 0) {
      // Cycle detected: not handled gracefully (caller catches).
      return [];
    }
    waves.push(wave);
    for (const id of wave) {
      remaining.delete(id);
      placed.add(id);
    }
  }
  return waves;
}

/**
 * Execute a Plan as a DAG. Steps in the same wave run in parallel.
 */
export async function executeDag(
  plan: Plan,
  ctx: TaskContext,
  handler: StepHandler,
  opts: DagExecutorOptions = {},
): Promise<PlanResult> {
  const stopOnError = opts.stopOnError !== false;
  const maxWaveSize = opts.maxWaveSize ?? Infinity;
  const t0 = Date.now();
  let firstError: ErrorRef | undefined;

  const waves = buildWaves(plan);
  if (waves.length === 0 && plan.steps.length > 0) {
    return {
      ok: false,
      steps: plan.steps,
      error: { code: '4001', message: 'dependency cycle detected in Plan' },
      totalDurationMs: 0,
    };
  }

  for (const wave of waves) {
    if (firstError && stopOnError) {
      for (const id of wave) {
        const s = plan.steps.find((x) => x.id === id);
        if (s) s.status = 'skipped';
      }
      continue;
    }
    const slice = wave.slice(0, maxWaveSize);
    await Promise.all(slice.map(async (id) => {
      const step = plan.steps.find((s) => s.id === id);
      if (!step) return;
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
        if (!firstError) firstError = err;
      }
      step.durationMs = Date.now() - ts;
    }));
    if (firstError && stopOnError) break;
  }

  return {
    ok: !firstError,
    steps: plan.steps,
    error: firstError,
    totalDurationMs: Date.now() - t0,
  };
}
