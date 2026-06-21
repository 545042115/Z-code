// CodingAgent — top-level V2 `IAgent` adapter backed by V1's
// `extensions/coding-agent/src/agent/agent-loop-adapter.ts`.
//
// Phase 6A: skeleton. R7 wires the real V1 `AgentLoop` behind this.
// The shape is fixed: implements V2 `IAgent` so V2 Orchestrator
// can dispatch to Coding like any other agent.
//
// The Coding Agent's job:
//   PLAN          — plan the task via CodingPlanner
//   EXECUTE       — execute tools via CodingToolRegistry
//   VERIFY        — verify via CodingVerifier
//   REFLECT       — reflect via CodingReflectionEngine
//   REPLAN        — replan on failure (up to maxAttempts)
//
// V2's runtime is the host; V1's loop is the engine.

import type { AgentResult, IAgent, ModelSpec, TaskContext } from '@z-assistant/contracts';

export interface CodingAgentOptions {
  /**
   * Optional full IAgent implementation to delegate to. When set, all
   * IAgent methods (execute / canHandle / rollback / health) forward to
   * this impl. Used by R7 to wire the V1 AgentLoop (or the
   * vscode-connector's chat-agent) behind the V2 interface.
   */
  impl?: IAgent;
  /** Optional override for the V1 AgentLoop. Used by tests. */
  loop?: (ctx: TaskContext) => Promise<AgentResult>;
  /** Default model when the runtime doesn't pin one. */
  defaultModel?: ModelSpec;
  /** Max reflection attempts. */
  maxAttempts?: number;
}

export class CodingAgent implements IAgent {
  readonly name = 'coding';
  readonly role = 'Software Engineering';
  readonly capabilities: string[] = [
    'code.edit',
    'code.read',
    'code.test',
    'shell.run',
    'search.semantic',
    'search.symbolic',
  ];
  readonly dependencies: string[] = [];
  readonly modelPreference: ModelSpec;

  private readonly maxAttempts: number;

  constructor(private readonly opts: CodingAgentOptions = {}) {
    this.modelPreference = opts.defaultModel ?? { provider: 'sglang', name: 'default' };
    this.maxAttempts = opts.maxAttempts ?? 3;
  }

  canHandle(ctx: TaskContext): number | Promise<number> {
    if (this.opts.impl?.canHandle) return this.opts.impl.canHandle(ctx);
    return 1.0;
  }

  async execute(ctx: TaskContext): Promise<AgentResult> {
    if (this.opts.impl) return this.opts.impl.execute(ctx);
    if (this.opts.loop) return this.opts.loop(ctx);

    // Phase 6A stub. R7:
    //   1) buildPlan(ctx)        via CodingPlanner
    //   2) execute(plan, ctx)    via CodingToolRegistry
    //   3) verify(result)        via CodingVerifier
    //   4) reflect(...)          via CodingReflectionEngine
    //   5) re-plan until pass or maxAttempts
    return {
      ok: false,
      error: {
        code: '3001',
        message: 'CodingAgent.execute is a Phase 6A stub; wire V1 agent-loop in R7.',
      },
    };
  }

  async rollback(ctx: TaskContext): Promise<void> {
    if (this.opts.impl?.rollback) return this.opts.impl.rollback(ctx);
    // Phase 6A: no-op. R7 delegates to V1's EditTransactionManager.
  }

  async health() {
    if (this.opts.impl?.health) return this.opts.impl.health();
    return { ok: true, checkedAt: Date.now() };
  }
}
