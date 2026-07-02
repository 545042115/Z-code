import type { ILLMProvider, LLMMessage } from '../llm';
import type { AgentMetrics, ModelSpec } from '../agent';

export interface LlmCallOptions {
  llmProvider: ILLMProvider;
  model: ModelSpec;
  messages: LLMMessage[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  jsonMode?: boolean;
}

export interface LlmCallResult {
  content: string;
  raw: Awaited<ReturnType<ILLMProvider['generate']>>;
  metrics: AgentMetrics;
}

/**
 * Unified helper for a single LLM call with automatic metrics tracking.
 * Wraps the generate call, measures duration, and builds a standard metrics
 * object so callers don't have to repeat the same 6-field pattern.
 */
export async function callWithMetrics(
  opts: LlmCallOptions,
): Promise<LlmCallResult> {
  const t0 = performance.now();
  const res = await opts.llmProvider.generate({
    model: opts.model,
    messages: opts.messages,
    temperature: opts.temperature,
    maxTokens: opts.maxTokens,
    signal: opts.signal,
    jsonMode: opts.jsonMode,
  });
  return {
    content: res.message.content ?? '',
    raw: res,
    metrics: {
      tokensIn: res.usage.tokensIn,
      tokensOut: res.usage.tokensOut,
      costUsd: res.costUsd ?? 0,
      durationMs: Math.round(performance.now() - t0),
      llmCalls: 1,
      toolCalls: 0,
    },
  };
}
