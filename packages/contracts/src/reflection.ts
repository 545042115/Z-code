// Reflection Contracts — interface for the V2 Reflection Engine.
//
// `IReflectionEngine` takes an agent's output + verification result
// and decides what to do next (continue / replan / give up). Concrete
// reflection strategies (Coding's reflectionEngine, Research's
// summarizer) implement this interface.

import type { AgentResult } from './agent';
import type { TaskContext } from './agent';
import type { VerifierOutput } from './verifier';

// ── Reflection decision ──────────────────────────────────────────────

export type ReflectionAction = 'continue' | 'replan' | 'revise' | 'give_up';

export interface ReflectionDecision {
  /** What the agent should do next. */
  action: ReflectionAction;
  /** Human-readable rationale; recorded in spans. */
  rationale: string;
  /** 0-1; confidence in the recommendation. */
  confidence: number;
  /** Optional: revised prompt content to use for the next attempt. */
  revisedPrompt?: string;
  /** Optional: number of additional attempts allowed. */
  maxAttempts?: number;
}

// ── IReflectionEngine ─────────────────────────────────────────────────

export interface IReflectionEngine {
  readonly name: string;
  /**
   * Reflect on the previous attempt. Returns a decision used by
   * the orchestrator to drive the next iteration.
   */
  reflect(
    ctx: TaskContext,
    previousResult: AgentResult,
    verification: VerifierOutput | undefined,
    attempt: number,
    maxAttempts: number,
  ): Promise<ReflectionDecision>;
}
