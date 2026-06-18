// CodingReflectionEngine — V2 `IReflectionEngine` adapter backed by
// V1's `extensions/coding-agent/src/reflection/reflectionEngine.ts`.
//
// Phase 6A: skeleton. R7 wires the real V1 reflection engine (which
// uses RuntimeVerifier) behind this. The shape is fixed: implements
// V2 `IReflectionEngine` and returns a `ReflectionDecision`.

import type {
  AgentResult,
  IReflectionEngine,
  ReflectionDecision,
  TaskContext,
  VerifierOutput,
} from '@z-assistant/contracts';

export interface CodingReflectionOptions {
  impl?: (
    ctx: TaskContext,
    prev: AgentResult,
    v: VerifierOutput | undefined,
    attempt: number,
    max: number,
  ) => Promise<ReflectionDecision>;
}

export class CodingReflectionEngine implements IReflectionEngine {
  readonly name = 'coding-reflection';

  constructor(private readonly opts: CodingReflectionOptions = {}) {}

  async reflect(
    _ctx: TaskContext,
    _previousResult: AgentResult,
    _verification: VerifierOutput | undefined,
    _attempt: number,
    _maxAttempts: number,
  ): Promise<ReflectionDecision> {
    if (this.opts.impl) {
      return this.opts.impl(_ctx, _previousResult, _verification, _attempt, _maxAttempts);
    }
    // Phase 6A stub — R7 delegates to V1 `ReflectionEngine.reflect()`
    return {
      action: 'continue',
      rationale: 'CodingReflectionEngine is a Phase 6A stub; wire V1 reflection in R7.',
      confidence: 0,
    };
  }
}
