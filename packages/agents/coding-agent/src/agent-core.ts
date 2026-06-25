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

    const t = ctx.task.toLowerCase();

    // Strip commercial plan tokens so that "GLM coding plan" / "token
    // plan pricing" does NOT bleed into the coding score. The phrase
    // "coding plan" is a product name, not a coding task.
    const commercialSignals = [
      'coding plan', 'code plan', 'token plan', 'subscription plan',
      'coding套餐', 'token套餐', '订阅套餐', '价格表', 'pricing page',
    ];
    const isCommercial = commercialSignals.some((s) => t.includes(s));
    const sanitized = isCommercial
      ? t.replace(/coding\s*plan|code\s*plan|token\s*plan|subscription\s*plan/g, ' ')
      : t;

    // Strong coding signals — explicit code-work verbs.
    const strongCodingSignals = [
      '写代码', '写函数', '改代码', '改bug', '修bug', '调试', '重构',
      '实现', '编码', '编译', '跑测试', '跑用例', '单元测试',
      'write code', 'write a function', 'fix the bug', 'fix bug',
      'refactor', 'implement', 'debug', 'compile', 'run the test',
      'unit test', 'add a feature', 'fix the issue',
    ];
    // Medium coding signals — repo / file / language identifiers.
    const mediumCodingSignals = [
      '代码', '函数', '类', '接口', '模块', '仓库', '提交', '合并',
      'pull request', 'merge', 'commit', 'typescript', 'javascript',
      'python', 'rust', 'golang', 'java', 'cpp', 'react', 'vue',
      'regex', 'algorithm', 'sort', 'parse', 'json', 'yaml',
    ];

    let boost = 0;
    for (const k of strongCodingSignals) {
      if (sanitized.includes(k)) boost += 0.25;
    }
    for (const k of mediumCodingSignals) {
      if (sanitized.includes(k)) boost += 0.1;
    }
    boost = Math.min(boost, 0.7);

    // Base 0.2 — clearly below the research agent (0.45+) so we never
    // outrank a specialised agent by default. Only explicit coding
    // signals push us up.
    return 0.2 + boost;
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
