// Budget Guard Contracts — interface for V2 budget enforcement.
//
// `IBudgetGuard` watches a `Budget` and decides whether a
// pending operation (LLM call, tool call) is allowed under the
// remaining quota. Concrete guards may add per-agent / per-tool
// policies on top of the base budget.

import type { Budget } from './agent';

// ── Guard decision ────────────────────────────────────────────────────

export interface BudgetDecision {
  /** Is the operation allowed under the current budget? */
  allowed: boolean;
  /** If denied, structured reason. */
  reason?: { code: string; message: string };
  /** Remaining budget after this check. */
  remaining: Budget;
}

// ── Pending operation ────────────────────────────────────────────────

export type BudgetOpKind = 'llm_call' | 'tool_call' | 'agent_dispatch';

export interface BudgetOp {
  kind: BudgetOpKind;
  /** Estimated cost of the operation; the guard can adjust. */
  estimatedTokensIn?: number;
  estimatedTokensOut?: number;
  estimatedCostUsd?: number;
  /** Optional metadata for policy lookup. */
  agentName?: string;
  toolName?: string;
}

// ── IBudgetGuard ──────────────────────────────────────────────────────

export interface IBudgetGuard {
  readonly name: string;
  /**
   * Decide whether the pending operation is allowed under the
   * current budget. Implementation MAY mutate `remaining` to
   * record consumption; orchestrator treats it as authoritative.
   */
  check(budget: Budget, op: BudgetOp): Promise<BudgetDecision>;
  /** Commit a previously-allowed op's actual cost. */
  commit(budget: Budget, actual: { tokensIn: number; tokensOut: number; costUsd: number }): Budget;
}
