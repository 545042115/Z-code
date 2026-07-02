import type {
  IAgent,
  AgentMetrics,
  AgentResult,
  TaskContext,
  ModelSpec,
} from '../agent';
import type { ILLMProvider, LLMMessage } from '../llm';
import { ok as okResult, fail as failResult } from '../agent';
import { callWithMetrics } from './llm-call';

/**
 * Base class for stateful agents that run in loops or multiple steps.
 *
 * Provides:
 * - Centralised metrics tracking (tokens, cost, duration, LLM/tool calls)
 * - `callLLm` helper for consistent LLM invocation + metrics accumulation
 * - Default `canHandle` implementation (override as needed)
 *
 * Stateless agents (one-shot LLM call) can keep using the factory-function
 * pattern with `callWithMetrics` directly.
 */
export abstract class BaseAgent implements Omit<IAgent, 'name' | 'role' | 'capabilities' | 'dependencies' | 'modelPreference'> {
  protected readonly llm: ILLMProvider;
  protected readonly model: ModelSpec;
  protected readonly systemPrompt: string;
  private _metrics: AgentMetrics;

  constructor(opts: {
    llm: ILLMProvider;
    model: ModelSpec;
    systemPrompt: string;
  }) {
    this.llm = opts.llm;
    this.model = opts.model;
    this.systemPrompt = opts.systemPrompt;
    this._metrics = this._zeroMetrics();
  }

  // ── Public API (IAgent) ────────────────────────────────────────────

  abstract canHandle(ctx: TaskContext): number;
  abstract execute(ctx: TaskContext): Promise<AgentResult>;

  // ── Metrics helpers ────────────────────────────────────────────────

  protected get metrics(): AgentMetrics {
    return { ...this._metrics };
  }

  protected addToolCall(): void {
    this._metrics.toolCalls += 1;
  }

  protected addToolCalls(n: number): void {
    this._metrics.toolCalls += n;
  }

  protected resetMetrics(): void {
    this._metrics = this._zeroMetrics();
  }

  /**
   * Call the LLM and accumulate metrics. Returns the content string.
   * Adds 1 to llmCalls, adds to tokensIn/tokensOut/costUsd.
   */
  protected async callLLm(
    messages: LLMMessage[],
    opts: {
      temperature?: number;
      maxTokens?: number;
      signal?: AbortSignal;
      jsonMode?: boolean;
    } = {},
  ): Promise<string> {
    const result = await callWithMetrics({
      llmProvider: this.llm,
      model: this.model,
      messages,
      temperature: opts.temperature,
      maxTokens: opts.maxTokens,
      signal: opts.signal,
      jsonMode: opts.jsonMode,
    });
    this._metrics.tokensIn += result.metrics.tokensIn;
    this._metrics.tokensOut += result.metrics.tokensOut;
    this._metrics.costUsd += result.metrics.costUsd;
    this._metrics.llmCalls += result.metrics.llmCalls;
    return result.content;
  }

  /**
   * Convenience: system prompt + user message as a single-turn call.
   */
  protected async callLLmSingleTurn(
    userContent: string,
    opts: {
      temperature?: number;
      maxTokens?: number;
      signal?: AbortSignal;
      jsonMode?: boolean;
    } = {},
  ): Promise<string> {
    return this.callLLm(
      [
        { role: 'system', content: this.systemPrompt },
        { role: 'user', content: userContent },
      ],
      opts,
    );
  }

  // ── Result helpers ─────────────────────────────────────────────────

  protected okResult(
    content: unknown,
    extra: { artifacts?: Record<string, unknown>; durationMs?: number } = {},
  ): AgentResult {
    const metrics: AgentMetrics = {
      ...this._metrics,
      durationMs: extra.durationMs ?? this._metrics.durationMs,
    };
    return okResult(content, { artifacts: extra.artifacts, metrics });
  }

  protected failResult(code: string, message: string): AgentResult {
    return failResult(code, message);
  }

  // ── Private ────────────────────────────────────────────────────────

  private _zeroMetrics(): AgentMetrics {
    return {
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      durationMs: 0,
      llmCalls: 0,
      toolCalls: 0,
    };
  }
}
