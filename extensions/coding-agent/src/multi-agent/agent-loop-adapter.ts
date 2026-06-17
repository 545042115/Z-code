// IAgent adapter for the existing AgentLoop.
//
// Wraps the real `Plan → Execute → Verify → Repair` loop as a single
// `IAgent` so it can participate in the multi-agent Orchestrator.
// The wrapper:
//   - Reads `plan.dag` from SharedState (if present) to influence the task
//   - Mirrors the loop's `finalAnswer` into SharedState as `code.execution`
//   - Counts LLM / tool calls and tokens by reading the Run's accumulated usage
//   - Returns a proper `AgentResult` (ok / fail) based on LoopResult.state

import type { IAgent, TaskContext, AgentResult, AgentMetrics, ModelRef } from '../contracts';
import { ok, fail } from '../contracts';
import type { AgentLoop, LoopResult, ToolCall } from '../agent/agent-loop';

export interface AgentLoopAdapterOptions {
  /** Pre-built AgentLoop instance (DI-friendly). */
  loop: AgentLoop;
  /** Tags for routing / canHandle. */
  capabilities?: string[];
  /** Dependencies (defaults to ['researcher']). */
  dependencies?: string[];
  /** When set, used for canHandle scoring. */
  model?: ModelRef;
  /**
   * Read the Run's total tokens from the tracker snapshot.
   * Adapter computes delta between before/after.
   */
  getTokensUsed?: () => { tokensIn: number; tokensOut: number; costUsd: number };
  /** If true, append the agent task to "upstream plan" from SharedState. */
  useUpstreamPlan?: boolean;
}

const DEFAULT_CAPS = ['code.execute', 'code.edit', 'plan.execute'];

export class AgentLoopAdapter implements IAgent {
  public readonly name: string;
  public readonly role = 'Code Executor';
  public readonly capabilities: string[];
  public readonly dependencies: string[];
  public readonly modelPreference: ModelRef;
  private readonly opts: AgentLoopAdapterOptions;

  constructor(name: string, opts: AgentLoopAdapterOptions) {
    this.name = name;
    this.opts = opts;
    this.capabilities = opts.capabilities ?? DEFAULT_CAPS;
    this.dependencies = opts.dependencies ?? ['researcher'];
    this.modelPreference = opts.model ?? { provider: 'sglang', name: 'default' };
  }

  canHandle(ctx: TaskContext): number {
    const t = ctx.task.toLowerCase();
    if (/实现|写|执行|implement|execute|add|create|fix|修复|修改|edit/.test(t)) return 0.85;
    if (/跑|run|build|编译|test/.test(t)) return 0.6;
    return 0.15;
  }

  async execute(ctx: TaskContext): Promise<AgentResult> {
    // Compose effective task, optionally augmenting with upstream plan
    let effectiveTask = ctx.task;
    if (this.opts.useUpstreamPlan) {
      const plan = ctx.sharedState.get<{ steps?: string[]; summary?: string }>('plan.dag');
      if (plan?.steps?.length) {
        effectiveTask = `${ctx.task}\n\n[PLAN]\n${plan.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}`;
      } else if (plan?.summary) {
        effectiveTask = `${ctx.task}\n\n[PLAN]\n${plan.summary}`;
      }
    }

    const before = this.opts.getTokensUsed?.();
    const t0 = Date.now();

    let result: LoopResult;
    try {
      result = await this.opts.loop.executeTask(effectiveTask);
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      return fail('3001', m);
    }

    const after = this.opts.getTokensUsed?.();
    const durationMs = Date.now() - t0;
    const tokensIn = after && before ? Math.max(0, after.tokensIn - before.tokensIn) : 0;
    const tokensOut = after && before ? Math.max(0, after.tokensOut - before.tokensOut) : 0;
    const costUsd = after && before ? Math.max(0, after.costUsd - before.costUsd) : 0;

    // Map LoopState to ok/fail
    const isFail = result.state === 'FAILED' || result.state === 'REPLAN';
    if (isFail) {
      return fail('3002', result.finalAnswer || `loop state: ${result.state}`, {
        artifacts: { loopResult: result, state: result.state },
        metrics: makeMetrics(tokensIn, tokensOut, costUsd, durationMs, result.metrics.toolCalls),
      });
    }

    // Mirror outputs to SharedState
    ctx.sharedState.set('code.execution', {
      finalAnswer: result.finalAnswer,
      state: result.state,
      attempts: result.history.length,
    }, this.name);

    // Surface patch-level data if the loop recorded file changes
    const modifiedFiles: string[] = [];
    for (const attempt of result.history) {
      const iters = (attempt as { iterations?: { toolCall?: ToolCall }[] }).iterations
        ?? (attempt as { toolIterations?: { toolCall?: ToolCall }[] }).toolIterations
        ?? [];
      for (const iter of iters) {
        if (iter.toolCall?.name && /write|edit|create|patch/i.test(iter.toolCall.name)) {
          const p = (iter.toolCall.params?.path ?? iter.toolCall.params?.file) as string | undefined;
          if (p) modifiedFiles.push(p);
        }
      }
    }
    if (modifiedFiles.length) {
      ctx.sharedState.set('code.modified_files', modifiedFiles, this.name);
    }

    return ok(
      { finalAnswer: result.finalAnswer, state: result.state, attempts: result.history.length },
      {
        artifacts: {
          finalAnswer: result.finalAnswer,
          state: result.state,
          modifiedFiles,
        },
        metrics: makeMetrics(tokensIn, tokensOut, costUsd, durationMs, result.metrics.toolCalls),
      }
    );
  }
}

function makeMetrics(
  tokensIn: number, tokensOut: number, costUsd: number,
  durationMs: number, toolCalls: number
): AgentMetrics {
  return {
    tokensIn, tokensOut, costUsd, durationMs, llmCalls: 0, toolCalls,
  };
}
