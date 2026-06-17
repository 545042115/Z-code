// Config Center — load, merge, and validate the runtime ConfigSpec.
//
// Loading priority (per PHASE0_FOUNDATION.md §"配置中心"):
//   1. Environment variables (Z_ prefix, e.g. Z_BUDGET_PER_RUN_USD)
//   2. YAML file (default: ~/.z-assistant/config.yaml or `configPath`)
//   3. Built-in defaults
//
// Validation is fail-fast: any error throws and the extension refuses
// to start (per SECURITY.md principle: never silently fallback).
//
// This module is a working skeleton: it loads YAML, merges with
// defaults, and validates. A real impl will add file watching, hot
// reload, and zod-typed schema validation (see ADR 0006).

import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import * as yaml from 'js-yaml';
import { DEFAULT_CONFIG, type ConfigSpec } from '../../contracts';
import { ConfigErrorCode } from '../errors';
import type { ErrorRef } from '../../contracts';

export interface ConfigLoadOptions {
  /** Path to YAML file; default ~/.z-assistant/config.yaml */
  configPath?: string;
  /** Skip env overrides (used by tests). */
  skipEnv?: boolean;
}

export class ConfigError extends Error {
  readonly code: string;
  readonly category = 'config' as const;
  constructor(message: string, code: string = ConfigErrorCode.SchemaInvalid) {
    super(message);
    this.name = 'ConfigError';
    this.code = code;
  }
}

/** Load a ConfigSpec. Throws ConfigError on any failure. */
export async function loadConfig(opts: ConfigLoadOptions = {}): Promise<ConfigSpec> {
  const path = opts.configPath ?? defaultConfigPath();
  let fromFile: Partial<ConfigSpec> = {};
  if (existsSync(path)) {
    try {
      const raw = await readFile(path, 'utf8');
      fromFile = (yaml.load(raw) as Partial<ConfigSpec>) ?? {};
    } catch (e) {
      throw new ConfigError(
        `failed to load config at ${path}: ${(e as Error).message}`,
        ConfigErrorCode.SchemaInvalid,
      );
    }
  }

  const merged = deepMerge(structuredClone(DEFAULT_CONFIG), fromFile) as ConfigSpec;

  if (!opts.skipEnv) {
    applyEnvOverrides(merged);
  }

  validateConfig(merged);
  merged.meta = { ...merged.meta, loadedAt: Date.now(), sourcePath: path };
  return merged;
}

function defaultConfigPath(): string {
  return join(homedir(), '.z-assistant', 'config.yaml');
}

// ── Env overrides (Z_ prefix, e.g. Z_BUDGET_PER_RUN_USD=0.5) ──────────

function applyEnvOverrides(cfg: ConfigSpec): void {
  const e = process.env;
  const num = (v?: string) => (v ? Number(v) : undefined);

  // Budget
  const perRunUsd = num(e.Z_BUDGET_PER_RUN_USD);
  if (perRunUsd !== undefined) cfg.budget.perRunUsd = perRunUsd;
  const perDayUsd = num(e.Z_BUDGET_PER_DAY_USD);
  if (perDayUsd !== undefined) cfg.budget.perDayUsd = perDayUsd;
  const perRunTokens = num(e.Z_BUDGET_PER_RUN_TOKENS);
  if (perRunTokens !== undefined) cfg.budget.perRunTokens = perRunTokens;

  // Trace
  if (e.Z_TRACE_ENABLED === 'false') cfg.trace.enabled = false;
  if (e.Z_TRACE_ENABLED === 'true') cfg.trace.enabled = true;

  // Schema version pin
  if (e.Z_SCHEMA_VERSION) cfg.schemaVersion = e.Z_SCHEMA_VERSION;
}

// ── Validation ────────────────────────────────────────────────────────

export function validateConfig(cfg: ConfigSpec): void {
  if (!cfg.schemaVersion) {
    throw new ConfigError('schemaVersion is required', ConfigErrorCode.MissingRequired);
  }
  if (!cfg.budget || cfg.budget.perRunUsd <= 0) {
    throw new ConfigError('budget.perRunUsd must be > 0', ConfigErrorCode.SchemaInvalid);
  }
  if (cfg.budget.perDayUsd < cfg.budget.perRunUsd) {
    throw new ConfigError(
      'budget.perDayUsd must be >= budget.perRunUsd',
      ConfigErrorCode.SchemaInvalid,
    );
  }
  if (cfg.budget.perRunTokens <= 0) {
    throw new ConfigError('budget.perRunTokens must be > 0', ConfigErrorCode.SchemaInvalid);
  }
  if (!cfg.tools || !Array.isArray(cfg.tools.allow)) {
    throw new ConfigError('tools.allow must be an array', ConfigErrorCode.SchemaInvalid);
  }
  // Active prompt ids must exist in prompts map
  for (const [name, id] of Object.entries(cfg.activePrompts)) {
    if (!cfg.prompts[name]) {
      throw new ConfigError(
        `activePrompts['${name}'] points to non-existent prompt`,
        ConfigErrorCode.MissingRequired,
      );
    }
    if (!cfg.prompts[name].some((v) => v.id === id)) {
      throw new ConfigError(
        `activePrompts['${name}'] = '${id}' not found in prompts`,
        ConfigErrorCode.MissingRequired,
      );
    }
  }
}

// ── Deep merge helper ─────────────────────────────────────────────────

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function deepMerge<T>(base: T, over: Partial<T>): T {
  if (!isPlainObject(base) || !isPlainObject(over)) {
    return (over === undefined ? base : (over as T));
  }
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (isPlainObject(v) && isPlainObject(out[k])) {
      out[k] = deepMerge(out[k] as Record<string, unknown>, v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out as T;
}
