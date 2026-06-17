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
// Three execution modes:
//   1. `sequential` — agents run one after another, in dependency order
//   2. `parallel`   — agents run concurrently, all results aggregated
//   3. `dag`        — agents run in topo order; parallel where no edge
//
// The orchestrator does NOT itself call LLMs. It only orchestrates.

import type {
  IAgent,
  TaskContext,
  AgentResult,
  ModelRef,
  RunStatus,
  ErrorRef,
} from '../contracts';
import type { RunTracker, Span } from '../trace';
import { AgentRegistry, DependencyCycleError } from './agent-registry';
import { SharedState } from './shared-state';
import { classify } from '../infra/errors';
import { BudgetGuard, BudgetExceededError } from '../infra/cost/budget';
import { ok, fail } from '../contracts';

export type OrchestratorMode = 'sequential' | 'parallel' | 'dag';

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
}

export interface OrchestratorResult {
  status: RunStatus;
  outputs: AgentResult[];
  sharedStateSnapshot: ReturnType<SharedState['snapshot']>;
  error?: ErrorRef;
}

export class Orchestrator {
  private readonly opts: Required<Omit<OrchestratorOptions, 'userId' | 'initialState' | 'metadata' | 'agents' | 'budgetGuard'>> & Pick<OrchestratorOptions, 'userId' | 'initialState' | 'metadata' | 'agents' | 'budgetGuard'>;

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

    try {
      const order = this._resolveOrder();
      root.setAttribute('agent.count', order.length);
      root.addEvent('orchestrator.start', { count: order.length });

      // Wrap _runOne to enforce budget; returns a fail result if exceeded.
      const wrapped = (name: string) => {
        if (budgetExhausted) {
          return Promise.resolve(fail('3003', `budget exhausted before '${name}'`));
        }
        return this._runOne(name, sharedState, root).then((r) => {
          // Consume budget from metrics if present
          if (r.metrics && this.opts.budgetGuard) {
            try {
              this.opts.budgetGuard.consume(r.metrics.tokensIn + r.metrics.tokensOut, r.metrics.costUsd);
            } catch (e) {
              if (e instanceof BudgetExceededError) {
                budgetExhausted = true;
                const budgetErr = fail('3003', e.message);
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
        result = fail('3004', `agent ${name} returned invalid result`);
      } else {
        result = r;
      }
    } catch (e) {
      const cls = classify(e);
      result = fail(cls.code, cls.message);
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

    // If the agent wrote artifacts, mirror them into SharedState with
    // namespacing so other agents can subscribe.
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
    return ok(undefined);
  },
};
