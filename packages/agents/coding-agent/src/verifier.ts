// CodingVerifier — V2 `IVerifier` adapter backed by V1's
// `extensions/coding-agent/src/agent/verifier.ts`.
//
// Phase 6A: skeleton. R7 wires the real V1 verifier (which runs
// tsc / eslint / tests via the VSCode child_process API) behind
// this. The shape is fixed: implements V2 `IVerifier` and emits
// `VerifierOutput` with structured diagnostics.

import type { AgentResult, IVerifier, VerifierOutput } from '@z-assistant/contracts';

export interface CodingVerifierOptions {
  /** Optional override; used by tests. */
  impl?: (result: AgentResult) => Promise<VerifierOutput>;
}

export class CodingVerifier implements IVerifier {
  readonly name = 'coding-verifier';

  constructor(private readonly opts: CodingVerifierOptions = {}) {}

  async verify(_result: AgentResult): Promise<VerifierOutput> {
    if (this.opts.impl) return this.opts.impl(_result);
    // Phase 6A stub — R7 delegates to V1 `verifier.verify()`
    return {
      pass: false,
      stages: {},
      diagnostics: [],
      durationMs: 0,
      notes: 'CodingVerifier is a Phase 6A stub; wire V1 verifier in R7.',
    };
  }
}
