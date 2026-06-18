import type { ModelSpec } from '@z-assistant/contracts';
export interface ModelPrice {
    /** USD per 1k input tokens */
    inputPer1k: number;
    /** USD per 1k output tokens */
    outputPer1k: number;
    /** Optional flat per-request fee */
    perRequest?: number;
}
/** Built-in default prices; override via Config Center. */
export declare const DEFAULT_PRICING: Record<string, ModelPrice>;
/** Look up a price entry by `provider/name`; returns undefined if unknown. */
export declare function lookupPrice(spec: ModelSpec): ModelPrice | undefined;
/**
 * Compute USD cost for a given model + token usage.
 * Returns 0 when pricing is unknown (we never want a missing price to
 * crash the agent — just log a warning).
 */
export declare function computeCost(spec: ModelSpec, tokensIn: number, tokensOut: number): number;
//# sourceMappingURL=pricing.d.ts.map