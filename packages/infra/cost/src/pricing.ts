// Pricing — model token price table (USD per 1k tokens).
//
// Source: official provider pricing pages, refreshed 2026-06.
// In production this is loaded from the Config Center so users can override.

import type { ModelSpec } from '@ziner/contracts';

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
  // ── OpenAI (source: openai.com/api/pricing, March 2026) ──────────
  'openai/gpt-5.4':        { inputPer1k: 0.0025, outputPer1k: 0.015 },
  'openai/gpt-5.4-pro':    { inputPer1k: 0.015,  outputPer1k: 0.06 },
  'openai/gpt-5.2':        { inputPer1k: 0.00175, outputPer1k: 0.014 },
  'openai/gpt-5':          { inputPer1k: 0.00125, outputPer1k: 0.01 },
  'openai/gpt-5-mini':     { inputPer1k: 0.00025, outputPer1k: 0.002 },
  'openai/gpt-4.1':        { inputPer1k: 0.002,   outputPer1k: 0.008 },
  'openai/gpt-4.1-mini':   { inputPer1k: 0.0004,  outputPer1k: 0.0016 },
  'openai/gpt-4.1-nano':   { inputPer1k: 0.0001,  outputPer1k: 0.0004 },
  'openai/gpt-4o':         { inputPer1k: 0.0025,  outputPer1k: 0.01 },
  'openai/gpt-4o-mini':    { inputPer1k: 0.00015, outputPer1k: 0.0006 },
  'openai/o3':             { inputPer1k: 0.002,   outputPer1k: 0.008 },
  'openai/o4-mini':        { inputPer1k: 0.0011,  outputPer1k: 0.0044 },
  'openai/o1':             { inputPer1k: 0.015,   outputPer1k: 0.06 },
  'openai/o3-mini':        { inputPer1k: 0.0011,  outputPer1k: 0.0044 },

  // ── Anthropic (source: claude.com/pricing, June 2026) ────────────
  'anthropic/claude-opus-4.8':      { inputPer1k: 0.005, outputPer1k: 0.025 },
  'anthropic/claude-sonnet-4.6':    { inputPer1k: 0.003, outputPer1k: 0.015 },
  'anthropic/claude-haiku-4.5':     { inputPer1k: 0.001, outputPer1k: 0.005 },
  'anthropic/claude-fable-5':       { inputPer1k: 0.01,  outputPer1k: 0.05 },
  // Legacy aliases
  'anthropic/claude-3-5-sonnet':    { inputPer1k: 0.003, outputPer1k: 0.015 },
  'anthropic/claude-3-5-haiku':     { inputPer1k: 0.0008, outputPer1k: 0.004 },
  'anthropic/claude-3-opus':        { inputPer1k: 0.015, outputPer1k: 0.075 },

  // ── DeepSeek (source: api-docs.deepseek.com, June 2026) ──────────
  'deepseek/deepseek-v4-flash':     { inputPer1k: 0.00014, outputPer1k: 0.00028 },
  'deepseek/deepseek-v4-pro':       { inputPer1k: 0.000435, outputPer1k: 0.00087 },
  // Legacy aliases (deprecated 2026-07-24)
  'deepseek/deepseek-chat':         { inputPer1k: 0.00014, outputPer1k: 0.00028 },
  'deepseek/deepseek-reasoner':     { inputPer1k: 0.00055, outputPer1k: 0.00219 },

  // ── Google Gemini (source: ai.google.dev, June 2026) ─────────────
  'gemini/gemini-2.5-flash':        { inputPer1k: 0.0003,  outputPer1k: 0.0025 },
  'gemini/gemini-2.5-pro':          { inputPer1k: 0.00125, outputPer1k: 0.01 },
  'gemini/gemini-2.5-flash-lite':   { inputPer1k: 0.0001,  outputPer1k: 0.0004 },

  // ── Local / Free ─────────────────────────────────────────────────
  'ollama/default':                 { inputPer1k: 0, outputPer1k: 0 },
  'sglang/default':                 { inputPer1k: 0, outputPer1k: 0 },
  'mimo/mimo-v2-flash':             { inputPer1k: 0.0001, outputPer1k: 0.0003 },
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
