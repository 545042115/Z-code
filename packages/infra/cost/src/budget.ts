// Budget — per-Run and per-Day cost / token limits.
//
// `BudgetGuard` is a small stateful object that callers (Trace, Orchestrator)
// check before and update after each billable operation. Throwing
// `BudgetExceededError` is the contract that propagates through the agent.

import { AgentErrorCode } from '@ziner/infra-errors';
import type { Budget, BudgetPolicy } from '@ziner/contracts';

export class BudgetExceededError extends Error {
  readonly code = AgentErrorCode.BudgetExceeded;
  readonly category = 'agent' as const;
  constructor(message: string, public readonly over: {
    tokensLeft: number;
    costLeftUsd: number;
    perRunUsd: number;
    perRunTokens: number;
  }) {
    super(message);
    this.name = 'BudgetExceededError';
  }
}

/**
 * Per-Run budget tracker. Constructed at Run start with the active
 * `BudgetPolicy`. `consume()` is called after every billable op; throws
 * `BudgetExceededError` when limits are violated.
 */
export class BudgetGuard {
  private tokensSpent = 0;
  private costSpentUsd = 0;

  // Per-day tracking is process-wide; reset at midnight.
  private static perDaySpentUsd = 0;
  private static perDayResetAt = nextMidnight();

  constructor(private readonly policy: BudgetPolicy) {}

  /** Snapshot the current remaining budget (for TaskContext.budget). */
  snapshot(): Budget {
    return {
      tokensLeft: this.policy.perRunTokens - this.tokensSpent,
      costLeftUsd: Math.max(0, this.policy.perRunUsd - this.costSpentUsd),
    };
  }

  /** Record a billable operation. Throws if it would exceed the cap. */
  consume(tokens: number, costUsd: number): void {
    this.rolloverDayIfNeeded();
    if (this.tokensSpent + tokens > this.policy.perRunTokens) {
      throw new BudgetExceededError('per-run token cap exceeded', {
        tokensLeft: this.policy.perRunTokens - this.tokensSpent,
        costLeftUsd: this.policy.perRunUsd - this.costSpentUsd,
        perRunUsd: this.policy.perRunUsd,
        perRunTokens: this.policy.perRunTokens,
      });
    }
    if (this.costSpentUsd + costUsd > this.policy.perRunUsd) {
      throw new BudgetExceededError('per-run USD cap exceeded', {
        tokensLeft: this.policy.perRunTokens - this.tokensSpent,
        costLeftUsd: this.policy.perRunUsd - this.costSpentUsd,
        perRunUsd: this.policy.perRunUsd,
        perRunTokens: this.policy.perRunTokens,
      });
    }
    if (BudgetGuard.perDaySpentUsd + costUsd > this.policy.perDayUsd) {
      throw new BudgetExceededError('per-day USD cap exceeded', {
        tokensLeft: this.policy.perRunTokens - this.tokensSpent,
        costLeftUsd: this.policy.perRunUsd - this.costSpentUsd,
        perRunUsd: this.policy.perRunUsd,
        perRunTokens: this.policy.perRunTokens,
      });
    }
    this.tokensSpent += tokens;
    this.costSpentUsd += costUsd;
    BudgetGuard.perDaySpentUsd += costUsd;
  }

  /** Test helper: reset the per-day counter. */
  static resetDayCounter(): void {
    BudgetGuard.perDaySpentUsd = 0;
    BudgetGuard.perDayResetAt = nextMidnight();
  }

  private rolloverDayIfNeeded(): void {
    if (Date.now() >= BudgetGuard.perDayResetAt) {
      BudgetGuard.perDaySpentUsd = 0;
      BudgetGuard.perDayResetAt = nextMidnight();
    }
  }
}

function nextMidnight(): number {
  const d = new Date();
  d.setUTCHours(24, 0, 0, 0);
  return d.getTime();
}
