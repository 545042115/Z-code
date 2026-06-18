// Unit tests for config.ts helpers
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  DEFAULT_CONFIG,
  getActivePrompt,
  isToolAllowed,
  matchGlob,
  toolRequiresConfirm,
  ConfigSpec,
  PromptVersion,
} from '../config';

test('matchGlob: exact match', () => {
  assert.strictEqual(matchGlob('edit_file', 'edit_file'), true);
});

test('matchGlob: star matches single token (no dot)', () => {
  assert.strictEqual(matchGlob('shell_exec:*', 'shell_exec:rm_rf'), true);
  // `.` is excluded by `*` (avoids accidental cross-scope matches like 'shell_exec.x')
  assert.strictEqual(matchGlob('shell_exec:*', 'shell_exec:rm_rf.x'), false);
  // `:` is NOT excluded — sub-namespaces are matched (intentional, shell-glob style)
  assert.strictEqual(matchGlob('shell_exec:*', 'shell_exec:nested:cmd'), true);
});

test('matchGlob: mismatch', () => {
  assert.strictEqual(matchGlob('edit_file', 'write_file'), false);
});

test('matchGlob: special chars are escaped', () => {
  // `.` in the pattern must NOT match arbitrary char
  assert.strictEqual(matchGlob('a.b', 'axb'), false);
  assert.strictEqual(matchGlob('a.b', 'a.b'), true);
});

test('isToolAllowed: deny wins over allow', () => {
  const policy = { allow: ['shell_*'], deny: ['shell_exec:rm_rf'] };
  assert.strictEqual(isToolAllowed(policy, 'shell_exec:rm_rf'), false);
  assert.strictEqual(isToolAllowed(policy, 'shell_exec:ls'), true);
});

test('isToolAllowed: empty allow => nothing allowed', () => {
  const policy = { allow: [], deny: [] };
  assert.strictEqual(isToolAllowed(policy, 'edit_file'), false);
});

test('toolRequiresConfirm: matches per pattern', () => {
  const policy = { allow: [], deny: [], requireConfirm: ['shell_*', 'write_file'] };
  assert.strictEqual(toolRequiresConfirm(policy, 'shell_exec:ls'), true);
  assert.strictEqual(toolRequiresConfirm(policy, 'write_file'), true);
  assert.strictEqual(toolRequiresConfirm(policy, 'read_file'), false);
});

test('toolRequiresConfirm: undefined list => false', () => {
  const policy = { allow: [], deny: [] };
  assert.strictEqual(toolRequiresConfirm(policy, 'shell_exec'), false);
});

test('getActivePrompt: returns active version', () => {
  const v1: PromptVersion = {
    id: '1.0.0', name: 'agent.planner', role: 'planner',
    content: 'old', author: { kind: 'human', user: 'me' }, createdAt: 0,
  };
  const v2: PromptVersion = {
    id: '1.1.0', name: 'agent.planner', role: 'planner',
    content: 'new', author: { kind: 'human', user: 'me' }, createdAt: 1,
  };
  const cfg: ConfigSpec = {
    ...DEFAULT_CONFIG,
    prompts: { 'agent.planner': [v1, v2] },
    activePrompts: { 'agent.planner': '1.1.0' },
  };
  const p = getActivePrompt(cfg, 'agent.planner');
  assert.ok(p);
  assert.strictEqual(p?.id, '1.1.0');
  assert.strictEqual(p?.content, 'new');
});

test('getActivePrompt: missing prompt => undefined', () => {
  assert.strictEqual(getActivePrompt(DEFAULT_CONFIG, 'nope'), undefined);
});

test('getActivePrompt: missing active id => undefined', () => {
  const cfg: ConfigSpec = {
    ...DEFAULT_CONFIG,
    prompts: { 'agent.planner': [{ id: '1.0.0', name: 'agent.planner', role: 'planner', content: '', author: { kind: 'human', user: 'me' }, createdAt: 0 }] },
  };
  assert.strictEqual(getActivePrompt(cfg, 'agent.planner'), undefined);
});

test('DEFAULT_CONFIG: required keys present', () => {
  assert.ok(DEFAULT_CONFIG.models !== undefined);
  assert.ok(DEFAULT_CONFIG.budget.perRunUsd > 0);
  assert.ok(DEFAULT_CONFIG.tools.allow.length > 0);
  assert.ok(DEFAULT_CONFIG.experiment?.requireHumanApproval === true);
});
