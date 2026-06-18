// Verifier Contracts — interface for V2 verification.
//
// `IVerifier` runs after an agent dispatches and produces a
// pass/fail judgement plus structured diagnostics. Coding's
// `RuntimeVerifier` (tsc / eslint / tests) is one implementation;
// other agents can supply their own.

import type { AgentResult } from './agent';

// ── Verifier result ───────────────────────────────────────────────────

export interface VerifierDiagnostic {
  severity: 'error' | 'warning' | 'info';
  /** File path, if applicable. */
  file?: string;
  /** Line number (1-based), if applicable. */
  line?: number;
  /** Diagnostic message. */
  message: string;
  /** Diagnostic code, e.g. "TS2304" or eslint rule id. */
  code?: string;
}

export interface VerifierOutput {
  /** Did the agent's work pass verification? */
  pass: boolean;
  /** Per-stage outcome: build / test / lint / runtime. */
  stages: {
    build?: { pass: boolean; stdout?: string; stderr?: string };
    test?: { pass: boolean; stdout?: string; stderr?: string };
    lint?: { pass: boolean; stdout?: string; stderr?: string };
    runtime?: { pass: boolean; stdout?: string; stderr?: string };
  };
  /** Structured diagnostics; used for Reflection. */
  diagnostics: VerifierDiagnostic[];
  /** Wall-clock duration in ms. */
  durationMs: number;
  /** Optional human-readable summary. */
  notes?: string;
}

// ── IVerifier ─────────────────────────────────────────────────────────

export interface IVerifier {
  readonly name: string;
  /**
   * Verify the agent's result. Implementations are pure Node
   * (run tsc / shell / etc.) and MUST NOT block on network.
   * Optional: implementations may emit Spans via the supplied
   * tracer.
   */
  verify(result: AgentResult): Promise<VerifierOutput>;
}
