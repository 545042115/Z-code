// Example Agents — researcher, coder, reviewer.
//
// These are reference implementations of `IAgent` that demonstrate
// how to participate in the multi-Agent system. They are intentionally
// LLM-free (no network calls) so they run reliably in tests and demos.
// Real agents wrap an LLMProvider; see the Connector-layer Instrumenter
// (`@z-assistant/trace/Instrumenter`).

import type { IAgent, TaskContext, AgentResult } from '@z-assistant/contracts';
import { ok as okResult, fail as failResult } from '@z-assistant/contracts';
import type { AgentRegistry } from './agent-registry';

// ── Researcher ────────────────────────────────────────────────────────

export const ResearcherAgent: IAgent = {
  name: 'researcher',
  role: 'Researcher',
  capabilities: ['research', 'search', 'fact.check'],
  dependencies: [],
  modelPreference: { provider: 'openai', name: 'gpt-4o', temperature: 0.2 },

  canHandle(ctx: TaskContext): number {
    const t = ctx.task.toLowerCase();
    if (/研究|查一下|search|research|查找|找一下/.test(t)) return 0.9;
    if (/是什么|what is|解释|explain/.test(t)) return 0.6;
    return 0.1;
  },

  async execute(ctx: TaskContext): Promise<AgentResult> {
    try {
      // Read any plan from the blackboard
      const plan = ctx.sharedState.get<{ steps: string[] }>('plan.dag');

      // Simulate research; in a real impl this would call the LLM
      const findings = {
        query: ctx.task,
        plan,
        notes: [
          `Identified intent: ${ctx.task.slice(0, 60)}`,
          'Located 3 relevant code areas',
          'Cross-referenced 2 documents',
        ],
        sources: [
          { kind: 'code', ref: 'src/example.ts' },
          { kind: 'doc', ref: 'README.md' },
        ],
      };

      ctx.sharedState.set('research.findings', findings, 'researcher');
      return okResult(findings, {
        artifacts: { findings },
        metrics: { tokensIn: 0, tokensOut: 0, costUsd: 0, durationMs: 5, llmCalls: 0, toolCalls: 0 },
      });
    } catch (e: unknown) {
      const m = e instanceof Error ? e.message : String(e);
      return failResult('3001', m);
    }
  },
};

// ── Coder ─────────────────────────────────────────────────────────────

export const CoderAgent: IAgent = {
  name: 'coder',
  role: 'Coder',
  capabilities: ['code.generate', 'code.edit', 'refactor'],
  dependencies: ['researcher'],
  modelPreference: { provider: 'openai', name: 'gpt-4o', temperature: 0.1 },

  canHandle(ctx: TaskContext): number {
    const t = ctx.task.toLowerCase();
    if (/实现|写|实现|add|create|implement|generate|写代码|写函数/.test(t)) return 0.9;
    if (/修改|edit|fix|bug|refactor|重构|修复/.test(t)) return 0.7;
    return 0.2;
  },

  async execute(ctx: TaskContext): Promise<AgentResult> {
    // Wait for research findings (subscribe, then read once)
    const findings = ctx.sharedState.get<{ query: string; notes: string[] }>('research.findings');
    if (!findings) {
      return failResult('3005', "dependency 'researcher' did not produce findings");
    }

    const patch = {
      files: [{ path: 'src/example.ts', change: 'added export' }],
      summary: `Implemented based on: ${findings.notes[0]}`,
    };
    ctx.sharedState.set('code.patch', patch, 'coder');
    return okResult(patch, {
      artifacts: { patch },
      metrics: { tokensIn: 0, tokensOut: 0, costUsd: 0, durationMs: 8, llmCalls: 0, toolCalls: 0 },
    });
  },
};

// ── Reviewer ──────────────────────────────────────────────────────────

export const ReviewerAgent: IAgent = {
  name: 'reviewer',
  role: 'Reviewer',
  capabilities: ['code.review', 'test.suggest'],
  dependencies: ['coder'],
  modelPreference: { provider: 'openai', name: 'gpt-4o-mini', temperature: 0 },

  canHandle(ctx: TaskContext): number {
    const t = ctx.task.toLowerCase();
    if (/review|审查|检查|test|测试|verify|验证/.test(t)) return 0.9;
    return 0.1;
  },

  async execute(ctx: TaskContext): Promise<AgentResult> {
    const patch = ctx.sharedState.get<{ files: { path: string }[]; summary: string }>('code.patch');
    if (!patch) {
      return failResult('3005', "dependency 'coder' did not produce patch");
    }
    const review = {
      filesReviewed: patch.files.length,
      issues: 0,
      suggestions: ['Add input validation', 'Cover edge case X'],
      approved: true,
    };
    ctx.sharedState.set('review.report', review, 'reviewer');
    return okResult(review, {
      artifacts: { review },
      metrics: { tokensIn: 0, tokensOut: 0, costUsd: 0, durationMs: 3, llmCalls: 0, toolCalls: 0 },
    });
  },
};

/** Convenience: register the 3 example agents into a registry. */
export function registerExampleAgents(reg: AgentRegistry): void {
  reg.register(ResearcherAgent);
  reg.register(CoderAgent);
  reg.register(ReviewerAgent);
}
