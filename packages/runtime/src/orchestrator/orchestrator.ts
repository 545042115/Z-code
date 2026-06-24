// Orchestrator — coordinates execution of multiple IAgents.
//
// Responsibilities:
//   - Build a TaskContext (with SharedState + Budget + trace Span)
//   - Dispatch to selected agents (sequential or fan-out)
//   - Respect dependencies (topo order)
//   - Aggregate results
//   - Record an `orchestrator` Span containing child agent Spans
//   - Enforce budget + max iterations
//
// Three primary execution modes:
//   1. `sequential` — agents run one after another, in dependency order
//   2. `parallel`   — agents run concurrently, all results aggregated
//   3. `dag`        — agents run in topo order; parallel where no edge
//
// Plus one P2 multi-agent mode:
//   4. `plan`       — first runs the planner, then dispatches sub-tasks
//                     from `SharedState['plan.dag']` in waves, then
//                     runs the synthesizer when there are multiple
//                     sub-task outputs. Requires `plannerAgent` to be
//                     set and a 'synthesizer' agent in the registry
//                     (synthesizer is optional but recommended).
//
// The orchestrator does NOT itself call LLMs. It only orchestrates.

import type {
  IAgent,
  TaskContext,
  AgentResult,
  ModelRef,
  RunStatus,
  ErrorRef,
  PlanDag,
  SubTask,
} from '@z-assistant/contracts';
import { ok as okResult, fail as failResult } from '@z-assistant/contracts';
import type { RunTracker, Span } from '@z-assistant/trace';
import { classify } from '@z-assistant/infra-errors';
import { BudgetGuard, BudgetExceededError } from '@z-assistant/infra-cost';
import { AgentRegistry, DependencyCycleError } from './agent-registry';
import { SharedState } from './shared-state';

export type OrchestratorMode = 'sequential' | 'parallel' | 'dag' | 'plan';

export interface OrchestratorOptions {
  tracker: RunTracker;
  registry: AgentRegistry;
  task: string;
  model: ModelRef;
  sessionId: string;
  userId?: string;
  mode?: OrchestratorMode;
  /** Maximum total agent calls across this orchestrator. Default 16. */
  maxAgentCalls?: number;
  /** Pre-existing shared state (e.g. restored from earlier Run). */
  initialState?: Record<string, unknown>;
  /** Optional override of agent names. Default: registry.list() in topo order. */
  agents?: string[];
  /** Optional per-context extras to inject into TaskContext.metadata. */
  metadata?: Record<string, string | number | boolean | null>;
  /**
   * Optional BudgetGuard. When set:
   *  - Checked before each agent dispatch (fail-fast)
   *  - Agent's `AgentMetrics.{tokensIn,tokensOut,costUsd}` is consumed after
   *  - On exceed, remaining agents are skipped with error code 3003
   */
  budgetGuard?: BudgetGuard;
  /** Optional abort signal for cancelling the run. */
  signal?: AbortSignal;
  /**
   * Name of the planner agent to invoke in `plan` mode. Must be
   * registered. The planner writes `SharedState['plan.dag']`; the
   * Orchestrator then dispatches the sub-tasks in dependency waves.
   * Required when `mode === 'plan'`.
   */
  plannerAgent?: string;
  /**
   * Name of the synthesizer agent to invoke in `plan` mode when
   * multiple sub-task outputs were produced. Defaults to 'synthesizer'.
   * Set to '' (empty) to skip synthesis and return the raw outputs.
   */
  synthesizerAgent?: string;
}

export interface OrchestratorResult {
  status: RunStatus;
  outputs: AgentResult[];
  sharedStateSnapshot: ReturnType<SharedState['snapshot']>;
  error?: ErrorRef;
}

export class Orchestrator {
  private readonly opts: Required<Omit<OrchestratorOptions, 'userId' | 'initialState' | 'metadata' | 'agents' | 'budgetGuard' | 'signal' | 'plannerAgent' | 'synthesizerAgent'>> & Pick<OrchestratorOptions, 'userId' | 'initialState' | 'metadata' | 'agents' | 'budgetGuard' | 'signal' | 'plannerAgent' | 'synthesizerAgent'>;

  constructor(opts: OrchestratorOptions) {
    this.opts = {
      mode: 'sequential',
      maxAgentCalls: 16,
      ...opts,
    };
  }

  // ── Public API ──────────────────────────────────────────────────────

  /** Run the orchestration. Always returns an OrchestratorResult. */
  async run(): Promise<OrchestratorResult> {
    const root = this.opts.tracker.startSpan({
      name: `orchestrator:${this.opts.mode}`,
      type: 'agent',
      input: {
        task: this.opts.task.slice(0, 200),
        mode: this.opts.mode,
        maxAgentCalls: this.opts.maxAgentCalls,
        budgetEnforced: !!this.opts.budgetGuard,
      },
    });
    const sharedState = new SharedState({ initial: this.opts.initialState });
    const outputs: AgentResult[] = [];
    let status: RunStatus = 'success';
    let firstError: ErrorRef | undefined;
    let agentCallCount = 0;
    let budgetExhausted = false;
    const signal = this.opts.signal;

    try {
      if (signal?.aborted) {
        throw new Error('run cancelled');
      }
      const order = this._resolveOrder();
      root.setAttribute('agent.count', order.length);
      root.addEvent('orchestrator.start', { count: order.length });

      // Wrap _runOne to enforce budget; returns a fail result if exceeded.
      const wrapped = (name: string) => {
        if (budgetExhausted) {
          return Promise.resolve(failResult('3003', `budget exhausted before '${name}'`));
        }
        return this._runOne(name, sharedState, root).then((r) => {
          // Consume budget from metrics if present
          if (r.metrics && this.opts.budgetGuard) {
            try {
              this.opts.budgetGuard.consume(r.metrics.tokensIn + r.metrics.tokensOut, r.metrics.costUsd);
            } catch (e) {
              if (e instanceof BudgetExceededError) {
                budgetExhausted = true;
                const budgetErr = failResult('3003', e.message);
                root.addEvent('budget.exceeded', { code: e.code });
                return budgetErr;
              }
              throw e;
            }
          }
          return r;
        });
      };

      switch (this.opts.mode) {
        case 'sequential': {
          for (const name of order) {
            if (signal?.aborted) {
              throw new Error('run cancelled');
            }
            if (agentCallCount >= this.opts.maxAgentCalls) {
              throw new Error(`max agent calls (${this.opts.maxAgentCalls}) exceeded`);
            }
            const result = await wrapped(name);
            outputs.push(result);
            agentCallCount++;
            if (!result.ok) {
              status = 'failed';
              firstError = result.error;
              break;  // fail-fast
            }
            if (budgetExhausted) break;
          }
          break;
        }
        case 'parallel': {
          if (signal?.aborted) {
            throw new Error('run cancelled');
          }
          const tasks = order.map((name) =>
            wrapped(name).then((r) => {
              agentCallCount++;
              return r;
            })
          );
          const results = await Promise.all(tasks);
          outputs.push(...results);
          const failed = results.find((r) => !r.ok);
          if (failed) {
            status = 'failed';
            firstError = failed.error;
          }
          break;
        }
        case 'dag': {
          const waves = this._toWaves(order);
          for (const wave of waves) {
            if (signal?.aborted) {
              throw new Error('run cancelled');
            }
            if (agentCallCount >= this.opts.maxAgentCalls) {
              throw new Error(`max agent calls (${this.opts.maxAgentCalls}) exceeded`);
            }
            const tasks = wave.map((name) =>
              wrapped(name).then((r) => {
                agentCallCount++;
                return r;
              })
            );
            const results = await Promise.all(tasks);
            outputs.push(...results);
            const failed = results.find((r) => !r.ok);
            if (failed) {
              status = 'failed';
              firstError = failed.error;
              break;
            }
            if (budgetExhausted) break;
          }
          break;
        }
        case 'plan': {
          // P2 multi-agent: Planner → sub-tasks per plan.dag → Synthesizer.
          if (signal?.aborted) throw new Error('run cancelled');
          if (!this.opts.plannerAgent) {
            throw new Error('plan mode requires `plannerAgent` to be set');
          }
          if (!this.opts.registry.has(this.opts.plannerAgent)) {
            throw new Error(`planner agent '${this.opts.plannerAgent}' is not registered`);
          }
          root.addEvent('plan.start', { planner: this.opts.plannerAgent });

          // Phase 1: run the planner. It writes `plan.dag` to SharedState.
          if (agentCallCount >= this.opts.maxAgentCalls) {
            throw new Error(`max agent calls (${this.opts.maxAgentCalls}) exceeded`);
          }
          const planResult = await wrapped(this.opts.plannerAgent);
          outputs.push(planResult);
          agentCallCount++;
          if (!planResult.ok) {
            status = 'failed';
            firstError = planResult.error;
            root.addEvent('plan.planner_failed', { code: planResult.error?.code ?? 'unknown' });
            break;
          }
          if (budgetExhausted) break;

          // Read the plan. If the planner didn't produce a usable one,
          // fall back to single-agent behaviour (use the planner's own
          // output as the final answer).
          const plan = sharedState.get<PlanDag>('plan.dag');
          if (!plan || !Array.isArray(plan.subtasks) || plan.subtasks.length === 0) {
            root.addEvent('plan.empty', {});
            break;
          }
          root.addEvent('plan.dag_ready', { subtasks: plan.subtasks.length });

          // Phase 2: dispatch sub-tasks in dependency waves.
          const subWaves = this._planToWaves(plan);
          const subTaskOutputs: AgentResult[] = [];
          for (const wave of subWaves) {
            if (signal?.aborted) throw new Error('run cancelled');
            if (agentCallCount + wave.length > this.opts.maxAgentCalls) {
              throw new Error(`max agent calls (${this.opts.maxAgentCalls}) exceeded`);
            }
            const tasks = wave.map(async (subTask) => {
              if (budgetExhausted) {
                return failResult('3003', `budget exhausted before '${subTask.id}'`);
              }
              // Resolve the assigned agent. Unknown names fall back to
              // the chat agent when present, else the first registered
              // agent. The fallback is recorded in the parent Span so
              // the operator can see what happened.
              const assignedName = this._resolveAssignedAgent(subTask.assignedTo);
              if (assignedName !== subTask.assignedTo) {
                root.addEvent('plan.subtask.fallback', {
                  subTask: subTask.id,
                  requested: subTask.assignedTo,
                  used: assignedName,
                });
              }
              const result = await this._runOneWithTask(
                assignedName,
                subTask.prompt,
                sharedState,
                root,
                subTask.id,
              );
              agentCallCount++;
              // Persist the sub-task output for the synthesizer.
              if (result.ok && result.output !== undefined) {
                sharedState.set(
                  `subtasks.${subTask.id}.output`,
                  result.output,
                  `subtask:${subTask.id}`,
                );
              }
              return result;
            });
            const results = await Promise.all(tasks);
            outputs.push(...results);
            subTaskOutputs.push(...results);
            // Continue on failure so the synthesizer can surface partial
            // results; only break when the budget is blown.
            if (budgetExhausted) break;
          }
          if (budgetExhausted) break;

          // Phase 3: synthesizer — only when there are ≥ 2 sub-task
          // outputs (single-output case is the fast path; the caller
          // already has the answer from the sub-task).
          const successfulOutputs = subTaskOutputs.filter((r) => r.ok);
          const synthName = this.opts.synthesizerAgent === '' ? '' : (this.opts.synthesizerAgent ?? 'synthesizer');
          if (successfulOutputs.length >= 2 && synthName && this.opts.registry.has(synthName)) {
            if (agentCallCount >= this.opts.maxAgentCalls) {
              throw new Error(`max agent calls (${this.opts.maxAgentCalls}) exceeded`);
            }
            root.addEvent('plan.synthesize', { sources: successfulOutputs.length });
            const synthResult = await wrapped(synthName);
            outputs.push(synthResult);
            agentCallCount++;
            if (!synthResult.ok) {
              // Synthesis failed — fall through with raw outputs rather
              // than fail the whole run, since the user already has the
              // data.
              root.addEvent('plan.synthesize_failed', { code: synthResult.error?.code ?? 'unknown' });
            }
          }
          break;
        }
      }
    } catch (e) {
      const cls = classify(e);
      root.fail(cls);
      return {
        status: 'failed',
        outputs,
        sharedStateSnapshot: sharedState.snapshot(),
        error: cls,
      };
    }

    root.setOutput({
      status,
      agentCalls: agentCallCount,
      outputs: outputs.length,
    });
    if (status === 'failed' && firstError) {
      root.setAttribute('error.code', firstError.code);
    }
    root.end();

    return {
      status,
      outputs,
      sharedStateSnapshot: sharedState.snapshot(),
      error: firstError,
    };
  }

  // ── Internals ───────────────────────────────────────────────────────

  private _resolveOrder(): string[] {
    const names = this.opts.agents ?? this.opts.registry.list().map((a) => a.name);
    if (names.length === 0) {
      throw new Error('no agents available');
    }
    // Resolve topo to validate dependencies and ensure correct order
    // in sequential / dag modes. parallel mode preserves user-specified
    // order (dependencies still get awaited via SharedState polling).
    if (this.opts.mode === 'parallel') return names;
    return this.opts.registry.resolveOrder(names);
  }

  /** Group agents into waves of independent agents (for 'dag' mode). */
  private _toWaves(names: string[]): string[][] {
    const waves: string[][] = [];
    const placed = new Set<string>();
    const remaining = new Set(names);

    while (remaining.size > 0) {
      const wave: string[] = [];
      for (const n of remaining) {
        const deps = this.opts.registry.get(n).dependencies;
        if (deps.every((d) => !remaining.has(d) || placed.has(d))) {
          wave.push(n);
        }
      }
      if (wave.length === 0) {
        // Should be impossible after resolveOrder succeeded
        throw new DependencyCycleError([...remaining]);
      }
      waves.push(wave);
      for (const n of wave) {
        placed.add(n);
        remaining.delete(n);
      }
    }
    return waves;
  }

  private async _runOne(
    name: string,
    sharedState: SharedState,
    parentSpan: Span
  ): Promise<AgentResult> {
    const agent = this.opts.registry.get(name);
    const ctx: TaskContext = {
      task: this.opts.task,
      model: this.opts.model,
      sessionId: this.opts.sessionId,
      userId: this.opts.userId,
      sharedState,
      parentRunId: this.opts.tracker.id,
      traceId: this.opts.tracker.traceId,
      budget: this.opts.budgetGuard
        ? this.opts.budgetGuard.snapshot()
        : { tokensLeft: 0, costLeftUsd: 0 },
      metadata: this.opts.metadata ?? {},
      signal: this.opts.signal,
    };

    const span = this.opts.tracker.startSpan({
      name: `agent:${name}`,
      type: 'agent',
      agent: name,
      input: { task: ctx.task.slice(0, 200) },
      parentSpanId: parentSpan.id,
    });

    let result: AgentResult;
    try {
      const r = await agent.execute(ctx);
      if (!r || (typeof r.ok !== 'boolean')) {
        result = failResult('3004', `agent ${name} returned invalid result`);
      } else {
        result = r;
      }
    } catch (e) {
      const cls = classify(e);
      result = failResult(cls.code, cls.message);
    }

    // Phase 5 A/B: if the agent surfaced a variant id via ctx.metadata
    // (typically set by `PromptedAgent`), tag the parent Run so
    // `QueryService.variantStats` can attribute runs to variants.
    const variantId = ctx.metadata?.['variant.id'];
    if (typeof variantId === 'string' && variantId.length > 0) {
      const tag = `variant:${variantId}`;
      try {
        await this.opts.tracker.updateMeta({ tags: [tag] });
      } catch {
        // tagging is best-effort; never fail the agent dispatch
      }
      span.setAttribute('variant.id', variantId);
    }

    span.setOutput({
      ok: result.ok,
      artifactKeys: Object.keys(result.artifacts ?? {}),
      metrics: result.metrics,
    });
    if (!result.ok) {
      span.fail(result.error!);
    }
    span.end();

    // Accumulate token/cost counters from agent metrics into the Run.
    // This ensures totalCostUsd is always computed from real token usage,
    // even when agents don't go through the Instrumenter.
    if (result.metrics && (result.metrics.tokensIn > 0 || result.metrics.tokensOut > 0)) {
      try {
        await this.opts.tracker.addUsage(result.metrics.tokensIn, result.metrics.tokensOut);
      } catch {
        // best-effort; never fail the agent dispatch
      }
    }

    // If the agent wrote artifacts, mirror them into SharedState with
    // namespacing so other agents can subscribe.
    if (result.artifacts) {
      for (const [k, v] of Object.entries(result.artifacts)) {
        sharedState.set(`artifacts.${name}.${k}`, v, name);
      }
    }

    return result;
  }

  // ── Plan-mode helpers ───────────────────────────────────────────────

  /**
   * Group sub-tasks into waves respecting their `dependsOn` edges.
   * Sub-tasks whose dependencies are all already placed run together
   * in the same wave. Mirrors the algorithm used for `dag` mode but
   * operates on SubTask ids rather than agent names, and does NOT
   * require topological validation up-front (the planner should have
   * produced a valid DAG; if not, a cycle error surfaces naturally).
   */
  private _planToWaves(plan: PlanDag): SubTask[][] {
    const byId = new Map<string, SubTask>();
    for (const st of plan.subtasks) byId.set(st.id, st);

    const waves: SubTask[][] = [];
    const placed = new Set<string>();
    const remaining = new Set(byId.keys());

    while (remaining.size > 0) {
      const wave: SubTask[] = [];
      for (const id of remaining) {
        const st = byId.get(id)!;
        // A sub-task is ready when all of its `dependsOn` either refer
        // to nodes that have been placed already, or to nodes that are
        // no longer in scope (e.g. dropped by the planner's hard cap).
        const ready = st.dependsOn.every((d) => placed.has(d) || !byId.has(d));
        if (ready) wave.push(st);
      }
      if (wave.length === 0) {
        // Cycle or unsatisfiable deps. Treat the unsatisfied set as a
        // final wave so we don't lose the work; the agent may still
        // produce useful output. Real cycles should be rare since the
        // planner is guided to avoid them.
        for (const id of remaining) wave.push(byId.get(id)!);
      }
      waves.push(wave);
      for (const st of wave) {
        placed.add(st.id);
        remaining.delete(st.id);
      }
    }
    return waves;
  }

  /**
   * Resolve the agent name the planner picked for a sub-task. If the
   * name is not registered, fall back to the chat agent (commonly
   * present), else the first registered agent. The fallback is
   * recorded on the Span so the operator can spot miscalibrated
   * decompositions.
   */
  private _resolveAssignedAgent(requested: string): string {
    if (this.opts.registry.has(requested)) return requested;
    if (this.opts.registry.has('chat')) return 'chat';
    // Last resort: any agent. Sort for determinism.
    const names = this.opts.registry.list().map((a) => a.name).sort();
    if (names.length > 0) return names[0];
    throw new Error(`no agents available to run sub-task assigned to '${requested}'`);
  }

  /**
   * Like `_runOne` but lets the caller override the task passed in
   * `TaskContext.task`. Used by `plan` mode to dispatch sub-task
   * prompts without rewriting `this.opts.task` for the whole run.
   * Optionally tags the resulting Span with the originating sub-task
   * id so the trace view groups them.
   */
  private async _runOneWithTask(
    name: string,
    task: string,
    sharedState: SharedState,
    parentSpan: Span,
    subTaskId?: string,
  ): Promise<AgentResult> {
    const agent = this.opts.registry.get(name);
    const ctx: TaskContext = {
      task,
      model: this.opts.model,
      sessionId: this.opts.sessionId,
      userId: this.opts.userId,
      sharedState,
      parentRunId: this.opts.tracker.id,
      traceId: this.opts.tracker.traceId,
      budget: this.opts.budgetGuard
        ? this.opts.budgetGuard.snapshot()
        : { tokensLeft: 0, costLeftUsd: 0 },
      metadata: {
        ...(this.opts.metadata ?? {}),
        ...(subTaskId ? { 'subtask.id': subTaskId } : {}),
      },
      signal: this.opts.signal,
    };

    const span = this.opts.tracker.startSpan({
      name: subTaskId ? `subtask:${subTaskId}` : `agent:${name}`,
      type: 'agent',
      agent: name,
      input: { task: task.slice(0, 200) },
      parentSpanId: parentSpan.id,
    });
    if (subTaskId) span.setAttribute('subtask.id', subTaskId);

    let result: AgentResult;
    try {
      const r = await agent.execute(ctx);
      if (!r || (typeof r.ok !== 'boolean')) {
        result = failResult('3004', `agent ${name} returned invalid result`);
      } else {
        result = r;
      }
    } catch (e) {
      const cls = classify(e);
      result = failResult(cls.code, cls.message);
    }

    span.setOutput({
      ok: result.ok,
      artifactKeys: Object.keys(result.artifacts ?? {}),
      metrics: result.metrics,
    });
    if (!result.ok) span.fail(result.error!);
    span.end();

    if (result.metrics && (result.metrics.tokensIn > 0 || result.metrics.tokensOut > 0)) {
      try {
        await this.opts.tracker.addUsage(result.metrics.tokensIn, result.metrics.tokensOut);
      } catch { /* best-effort */ }
    }

    if (result.artifacts) {
      for (const [k, v] of Object.entries(result.artifacts)) {
        sharedState.set(`artifacts.${name}.${k}`, v, name);
      }
    }
    return result;
  }
}

/** Convenience: a no-op agent for tests and stubbing. */
export const NoopAgent: IAgent = {
  name: 'noop',
  role: 'Noop',
  capabilities: ['test'],
  dependencies: [],
  modelPreference: { provider: 'sglang', name: 'default', temperature: 0 },
  canHandle: () => 0,
  async execute(): Promise<AgentResult> {
    return okResult(undefined);
  },
};
