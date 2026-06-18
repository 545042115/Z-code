import type { Budget, BudgetPolicy } from '@z-assistant/contracts';
export declare class BudgetExceededError extends Error {
    readonly over: {
        tokensLeft: number;
        costLeftUsd: number;
        perRunUsd: number;
        perRunTokens: number;
    };
    readonly code: "3002";
    readonly category: "agent";
    constructor(message: string, over: {
        tokensLeft: number;
        costLeftUsd: number;
        perRunUsd: number;
        perRunTokens: number;
    });
}
/**
 * Per-Run budget tracker. Constructed at Run start with the active
 * `BudgetPolicy`. `consume()` is called after every billable op; throws
 * `BudgetExceededError` when limits are violated.
 */
export declare class BudgetGuard {
    private readonly policy;
    private tokensSpent;
    private costSpentUsd;
    private static perDaySpentUsd;
    private static perDayResetAt;
    constructor(policy: BudgetPolicy);
    /** Snapshot the current remaining budget (for TaskContext.budget). */
    snapshot(): Budget;
    /** Record a billable operation. Throws if it would exceed the cap. */
    consume(tokens: number, costUsd: number): void;
    /** Test helper: reset the per-day counter. */
    static resetDayCounter(): void;
    private rolloverDayIfNeeded;
}
//# sourceMappingURL=budget.d.ts.map