// Configuration Contracts — the shape of the ConfigSpec loaded by
// infra/config/config-center.ts (Phase 0).
//
// All Prompt / Tool / Skill assets MUST come from the config center.
// Source code MUST NOT hardcode prompt bodies or tool allow/deny lists.
// This is enforced by ADR 0006 and enables the Evolution layer (Phase 5)
// to version, A/B-test, and roll back these assets safely.
//
// The schema is intentionally explicit (no `any`) so that
// `infra/config/schema.ts` can validate at startup with zod/valibot.

import type { ModelSpec } from './agent';

// ── Semver ────────────────────────────────────────────────────────────

/** Semantic version, e.g. "1.2.3". Used by PromptVersion, ConfigSpec. */
export type SemVer = string;

// ── PromptAsset ───────────────────────────────────────────────────────

/** How a prompt is intended to be used. */
export type PromptRole =
  | 'system'
  | 'planner'
  | 'reflector'
  | 'verifier'
  | 'judge'
  | 'router'
  | 'skill'
  | 'custom';

/**
 * A versioned prompt asset. Multiple versions can coexist for A/B testing
 * (Phase 5). The active version is selected by `ConfigSpec.prompts[name]`
 * pointing at a specific `PromptVersion.id`.
 */
export interface PromptVersion {
  /** Unique version id, semver recommended, e.g. "1.2.0" */
  id: SemVer;
  /** Stable asset name used by code, e.g. "agent.planner" */
  name: string;
  /** The role this prompt plays (informational) */
  role: PromptRole;
  /** Actual prompt text. May contain `{{var}}` placeholders. */
  content: string;
  /** Model this prompt was tuned for (informational) */
  tunedFor?: ModelSpec;
  /** Author; "human" or "evolution:v1" for engine-generated versions */
  author: PromptAuthor;
  /** Epoch milliseconds */
  createdAt: number;
  /** Free-form changelog */
  changelog?: string;
  /** Latest observed metrics (periodically refreshed by infra/evolution) */
  metrics?: PromptMetrics;
}

export type PromptAuthor =
  | { kind: 'human'; user: string }
  | { kind: 'evolution'; engineVersion: SemVer; parentVersion?: SemVer }
  | { kind: 'import'; from: string };

export interface PromptMetrics {
  /** 0-1; refresh at most daily */
  successRate?: number;
  /** Average cost per Run in USD */
  avgCostUsd?: number;
  /** Sample size behind the metrics */
  sampleSize?: number;
  /** Epoch milliseconds of the last refresh */
  refreshedAt?: number;
}

// ── Tool Policy ───────────────────────────────────────────────────────

/** Tool allow/deny policy; matched by tool name (glob). */
export interface ToolPolicy {
  /** Glob patterns of allowed tools, e.g. ["edit_file", "shell_exec:read_*"] */
  allow: string[];
  /** Glob patterns of denied tools; deny wins over allow */
  deny: string[];
  /** Tools that require explicit user confirmation per call */
  requireConfirm?: string[];
}

// ── Budget ────────────────────────────────────────────────────────────

/** Hard cost caps. Exceeding them terminates the Run with error 3002. */
export interface BudgetPolicy {
  /** Max USD per Run */
  perRunUsd: number;
  /** Max USD per UTC day */
  perDayUsd: number;
  /** Max tokens per Run (in + out combined) */
  perRunTokens: number;
}

// ── Experiment (Phase 5 Evolution) ────────────────────────────────────

/** A/B testing parameters used by the Evolution engine. */
export interface ExperimentConfig {
  /** Fraction of traffic held out from all experiments (default 0.1) */
  holdoutRatio: number;
  /** Minimum samples before a result is significant (default 30) */
  minSamples: number;
  /** p-value threshold for "winner" declaration (default 0.05) */
  significanceLevel: number;
  /** Max age (days) of samples used in a decision */
  maxSampleAgeDays: number;
  /** Auto-rollback if metric regresses by this fraction (default 0.1) */
  autoRollbackDelta: number;
  /** Required human approval before any change applies (default true) */
  requireHumanApproval: boolean;
}

// ── ConfigSpec ────────────────────────────────────────────────────────

/**
 * The full runtime configuration. Loaded once at startup, validated,
 * and frozen. Hot-reload is supported for individual sections (Phase 5).
 *
 * Loading priority: env vars > ~/.z-assistant/config.yaml > built-in defaults.
 * See infra/config/config-center.ts.
 */
export interface ConfigSpec {
  /** Schema version; bump on breaking changes */
  schemaVersion: SemVer;
  /** Available models; key = model alias used in code */
  models: Record<string, ModelSpec>;
  /**
   * Prompt registry. Key = stable prompt name.
   * Value = list of versions (newest first recommended).
   * Active version is selected by `active[name]`.
   */
  prompts: Record<string, PromptVersion[]>;
  /** Which version is currently active for each prompt name */
  activePrompts: Record<string, SemVer>;
  /** Tool allow/deny policy */
  tools: ToolPolicy;
  /** Cost caps */
  budget: BudgetPolicy;
  /** Trace settings */
  trace: TraceConfig;
  /** Evolution / A-B testing (Phase 5) */
  experiment?: ExperimentConfig;
  /** Extension metadata for debugging */
  meta?: ConfigMeta;
}

export interface TraceConfig {
  /** Master switch; when false, only minimal metadata is recorded */
  enabled: boolean;
  /** Days to keep SQLite rows (default 90) */
  retentionDays: number;
  /** Days to keep raw JSONL (default 30) */
  jsonlRetentionDays: number;
  /** Redact attribute keys whose name matches these globs */
  redactAttributePatterns: string[];
}

export interface ConfigMeta {
  /** Last successful load timestamp */
  loadedAt?: number;
  /** Path of the source file */
  sourcePath?: string;
  /** Config author / channel, e.g. "default", "team:platform" */
  channel?: string;
}

// ── Defaults ──────────────────────────────────────────────────────────

/** Built-in default config; merged with user overrides at load time. */
export const DEFAULT_CONFIG: ConfigSpec = {
  schemaVersion: '0.1.0',
  models: {},
  prompts: {},
  activePrompts: {},
  tools: {
    allow: ['read_file', 'edit_file', 'replace_text', 'web_search', 'web_fetch'],
    deny: ['shell_exec:rm_rf', 'shell_exec:force_push'],
    requireConfirm: ['shell_exec', 'write_file'],
  },
  budget: {
    perRunUsd: 1.0,
    perDayUsd: 20.0,
    perRunTokens: 200_000,
  },
  trace: {
    enabled: true,
    retentionDays: 90,
    jsonlRetentionDays: 30,
    redactAttributePatterns: ['*password*', '*secret*', '*api[_-]?key*', '*token*'],
  },
  experiment: {
    holdoutRatio: 0.1,
    minSamples: 30,
    significanceLevel: 0.05,
    maxSampleAgeDays: 14,
    autoRollbackDelta: 0.1,
    requireHumanApproval: true,
  },
};

// ── Helpers ───────────────────────────────────────────────────────────

/** Look up the active version of a prompt by name. */
export function getActivePrompt(
  config: ConfigSpec,
  name: string
): PromptVersion | undefined {
  const versions = config.prompts[name];
  const activeId = config.activePrompts[name];
  if (!versions || !activeId) return undefined;
  return versions.find((v) => v.id === activeId);
}

/** Decide whether a tool name is allowed by the policy. */
export function isToolAllowed(policy: ToolPolicy, toolName: string): boolean {
  if (matchAny(policy.deny, toolName)) return false;
  return matchAny(policy.allow, toolName);
}

/** Decide whether a tool requires per-call confirmation. */
export function toolRequiresConfirm(policy: ToolPolicy, toolName: string): boolean {
  return (policy.requireConfirm ?? []).some((p) => matchGlob(p, toolName));
}

/** Minimal glob matcher: `*` matches any non-dot sequence (shell-glob style).
 *  Examples:
 *    matchGlob('edit_file', 'edit_file')       === true
 *    matchGlob('shell_exec:*', 'shell_exec:ls') === true
 *    matchGlob('shell_exec:*', 'shell_exec:rm_rf.x') === false   // dot is excluded
 */
export function matchGlob(pattern: string, value: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '[^.]*');
  const re = new RegExp(`^${escaped}$`);
  return re.test(value);
}

function matchAny(patterns: string[], value: string): boolean {
  return patterns.some((p) => matchGlob(p, value));
}
