// Pricing — model token price table (USD per 1k tokens).
//
// Source: official provider pricing pages, refreshed manually.
// In production this is loaded from the Config Center so users can override.

import type { ModelSpec } from '../../contracts';

export interface ModelPrice {
  /** USD per 1k input tokens */
  inputPer1k: number;
  /** USD per 1k output tokens */
  outputPer1k: number;
  /** Optional flat per-request fee */
  perRequest?: number;
}

/** Built-in default prices; override via Config Center. */
export const DEFAULT_PRICING: Record<string, ModelPrice> = {
  // OpenAI (sample; not for production billing)
  'openai/gpt-4o':         { inputPer1k: 0.0025, outputPer1k: 0.01 },
  'openai/gpt-4o-mini':    { inputPer1k: 0.00015, outputPer1k: 0.0006 },
  'openai/o1':             { inputPer1k: 0.015,  outputPer1k: 0.06 },
  // Deepseek
  'deepseek/deepseek-chat':{ inputPer1k: 0.00014, outputPer1k: 0.00028 },
  // Xiaomi MiMo
  'mimo/mimo-v2-flash':    { inputPer1k: 0.0001,  outputPer1k: 0.0003 },
  // SGLang local — free
  'sglang/default':        { inputPer1k: 0,       outputPer1k: 0 },
};

/** Look up a price entry by `provider/name`; returns undefined if unknown. */
export function lookupPrice(spec: ModelSpec): ModelPrice | undefined {
  const key = `${spec.provider}/${spec.name}`;
  return DEFAULT_PRICING[key];
}

/**
 * Compute USD cost for a given model + token usage.
 * Returns 0 when pricing is unknown (we never want a missing price to
 * crash the agent — just log a warning).
 */
export function computeCost(
  spec: ModelSpec,
  tokensIn: number,
  tokensOut: number
): number {
  const p = lookupPrice(spec);
  if (!p) return 0;
  const cost = (tokensIn / 1000) * p.inputPer1k
             + (tokensOut / 1000) * p.outputPer1k
             + (p.perRequest ?? 0);
  // Round to 6 decimals to avoid floating point noise.
  return Math.round(cost * 1e6) / 1e6;
}
