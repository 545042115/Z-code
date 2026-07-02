// Unit tests for config-center
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { writeFile, mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadConfig, ConfigError, validateConfig } from '../config-center';
import { tryLoadSecret, loadSecret, SecretNotFoundError } from '../secrets';
import { DEFAULT_CONFIG } from '@ziner/contracts';

test('loadConfig: returns defaults when no file exists', async () => {
  const cfg = await loadConfig({ configPath: '/nonexistent/x.yaml', skipEnv: true });
  assert.strictEqual(cfg.schemaVersion, DEFAULT_CONFIG.schemaVersion);
  assert.strictEqual(cfg.budget.perRunUsd, DEFAULT_CONFIG.budget.perRunUsd);
});

test('loadConfig: loads and merges from YAML', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cfg-'));
  try {
    const file = join(dir, 'c.yaml');
    await writeFile(file, 'budget:\n  perRunUsd: 0.25\n  perDayUsd: 5\n');
    const cfg = await loadConfig({ configPath: file, skipEnv: true });
    assert.strictEqual(cfg.budget.perRunUsd, 0.25);
    assert.strictEqual(cfg.budget.perDayUsd, 5);
    // untouched
    assert.strictEqual(cfg.budget.perRunTokens, DEFAULT_CONFIG.budget.perRunTokens);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('loadConfig: invalid YAML throws ConfigError', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cfg-'));
  try {
    const file = join(dir, 'bad.yaml');
    await writeFile(file, ':\n  :\nbroken: [unclosed');
    await assert.rejects(
      () => loadConfig({ configPath: file, skipEnv: true }),
      ConfigError,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('loadConfig: env overrides win over file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cfg-'));
  try {
    const file = join(dir, 'c.yaml');
    await writeFile(file, 'budget:\n  perRunUsd: 0.25\n');
    process.env.Z_BUDGET_PER_RUN_USD = '0.99';
    try {
      const cfg = await loadConfig({ configPath: file });
      assert.strictEqual(cfg.budget.perRunUsd, 0.99);
    } finally {
      delete process.env.Z_BUDGET_PER_RUN_USD;
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('validateConfig: rejects perDayUsd < perRunUsd', () => {
  const bad = { ...DEFAULT_CONFIG, budget: { ...DEFAULT_CONFIG.budget, perRunUsd: 10, perDayUsd: 5 } };
  assert.throws(() => validateConfig(bad), ConfigError);
});

test('validateConfig: rejects activePrompts pointing to non-existent prompt', () => {
  const bad = { ...DEFAULT_CONFIG, activePrompts: { 'agent.planner': '1.0.0' } };
  assert.throws(() => validateConfig(bad), ConfigError);
});

test('validateConfig: rejects activePrompts id missing from prompt versions', () => {
  const bad = {
    ...DEFAULT_CONFIG,
    prompts: { 'agent.planner': [{ id: '0.9.0', name: 'agent.planner', role: 'planner' as const, content: '', author: { kind: 'human' as const, user: 'me' }, createdAt: 0 }] },
    activePrompts: { 'agent.planner': '1.0.0' },
  };
  assert.throws(() => validateConfig(bad), ConfigError);
});

test('secrets: tryLoadSecret returns env value', () => {
  process.env.TEST_SECRET = 'x';
  try {
    assert.strictEqual(tryLoadSecret('TEST_SECRET'), 'x');
    assert.strictEqual(tryLoadSecret('NONEXISTENT_SECRET_XYZ'), undefined);
  } finally {
    delete process.env.TEST_SECRET;
  }
});

test('secrets: loadSecret throws when missing', () => {
  assert.throws(() => loadSecret('NOPE_NOT_HERE'), SecretNotFoundError);
});
