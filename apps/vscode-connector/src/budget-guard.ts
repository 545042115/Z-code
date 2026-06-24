// @z-assistant/app-vscode-connector — BudgetGuard LLM provider wrapper.
//
// Wraps an ILLMProvider and enforces per-run and per-day cost/token caps.

import type { ILLMProvider, LLMRequest, LLMResponse, BudgetPolicy } from '@z-assistant/contracts';

export interface BudgetUsage {
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
}

export interface BudgetGuardOptions {
  /** Budget limits to enforce. */
  budget: BudgetPolicy;
  /** Mutable shared usage accumulator (per-run). */
  runUsage: BudgetUsage;
  /** Mutable shared usage accumulator (per-day). */
  dayUsage: BudgetUsage;
  /** Called whenever usage is updated. */
  onUpdate?: (usage: BudgetUsage) => void;
}

/**
 * Wraps an LLM provider so that every generate() call contributes to
 * per-run and per-day usage counters. Caps are checked before and after
 * each call; exceeding them throws a BUDGET_EXCEEDED error.
 */
export class BudgetGuardProvider implements ILLMProvider {
  readonly name: string;
  readonly supportedModels: string[];

  private inner: ILLMProvider;
  private budget: BudgetPolicy;
  private runUsage: BudgetUsage;
  private dayUsage: BudgetUsage;
  private onUpdate?: (usage: BudgetUsage) => void;

  constructor(inner: ILLMProvider, opts: BudgetGuardOptions) {
    this.inner = inner;
    this.name = `${inner.name}-budget-guard`;
    this.supportedModels = inner.supportedModels;
    this.budget = opts.budget;
    this.runUsage = opts.runUsage;
    this.dayUsage = opts.dayUsage;
    this.onUpdate = opts.onUpdate;
  }

  async generate(req: LLMRequest): Promise<LLMResponse> {
    this.checkBeforeCall();

    const res = await this.inner.generate(req);

    const tokensIn = res.usage.tokensIn;
    const tokensOut = res.usage.tokensOut;
    const costUsd = res.costUsd ?? 0;

    this.runUsage.tokensIn += tokensIn;
    this.runUsage.tokensOut += tokensOut;
    this.runUsage.costUsd += costUsd;

    this.dayUsage.tokensIn += tokensIn;
    this.dayUsage.tokensOut += tokensOut;
    this.dayUsage.costUsd += costUsd;

    this.onUpdate?.(this.runUsage);
    this.checkAfterCall();

    return res;
  }

  stream?(req: LLMRequest, onChunk: (chunk: import('@z-assistant/contracts').LLMMessage) => void): Promise<LLMResponse> {
    if (!this.inner.stream) {
      throw new Error('BUDGET_EXCEEDED: underlying provider does not support streaming');
    }
    this.checkBeforeCall();
    return this.inner.stream(req, onChunk).then((res) => {
      const tokensIn = res.usage.tokensIn;
      const tokensOut = res.usage.tokensOut;
      const costUsd = res.costUsd ?? 0;
      this.runUsage.tokensIn += tokensIn;
      this.runUsage.tokensOut += tokensOut;
      this.runUsage.costUsd += costUsd;
      this.dayUsage.tokensIn += tokensIn;
      this.dayUsage.tokensOut += tokensOut;
      this.dayUsage.costUsd += costUsd;
      this.onUpdate?.(this.runUsage);
      this.checkAfterCall();
      return res;
    });
  }

  health?(): Promise<{ ok: boolean; reason?: string; checkedAt: number }> {
    return this.inner.health?.() ?? Promise.resolve({ ok: true, checkedAt: Date.now() });
  }

  private checkBeforeCall(): void {
    if (this.budget.perRunTokens > 0 && this.runUsage.tokensIn + this.runUsage.tokensOut >= this.budget.perRunTokens) {
      throw new Error(
        `BUDGET_EXCEEDED: per-run token limit reached (${this.runUsage.tokensIn + this.runUsage.tokensOut} / ${this.budget.perRunTokens})`
      );
    }
    if (this.budget.perRunUsd > 0 && this.runUsage.costUsd >= this.budget.perRunUsd) {
      throw new Error(
        `BUDGET_EXCEEDED: per-run cost limit reached ($${this.runUsage.costUsd.toFixed(4)} / $${this.budget.perRunUsd})`
      );
    }
    if (this.budget.perDayUsd > 0 && this.dayUsage.costUsd >= this.budget.perDayUsd) {
      throw new Error(
        `BUDGET_EXCEEDED: per-day cost limit reached ($${this.dayUsage.costUsd.toFixed(4)} / $${this.budget.perDayUsd})`
      );
    }
  }

  private checkAfterCall(): void {
    if (this.budget.perRunTokens > 0 && this.runUsage.tokensIn + this.runUsage.tokensOut >= this.budget.perRunTokens) {
      throw new Error(
        `BUDGET_EXCEEDED: per-run token limit exceeded (${this.runUsage.tokensIn + this.runUsage.tokensOut} / ${this.budget.perRunTokens})`
      );
    }
    if (this.budget.perRunUsd > 0 && this.runUsage.costUsd >= this.budget.perRunUsd) {
      throw new Error(
        `BUDGET_EXCEEDED: per-run cost limit exceeded ($${this.runUsage.costUsd.toFixed(4)} / $${this.budget.perRunUsd})`
      );
    }
    if (this.budget.perDayUsd > 0 && this.dayUsage.costUsd >= this.budget.perDayUsd) {
      throw new Error(
        `BUDGET_EXCEEDED: per-day cost limit exceeded ($${this.dayUsage.costUsd.toFixed(4)} / $${this.budget.perDayUsd})`
      );
    }
  }
}
