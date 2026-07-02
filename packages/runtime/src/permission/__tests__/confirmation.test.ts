// @ziner/runtime — ConfirmationGate tests

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { ConfirmationGate } from '../index';
import type { AlwaysRule, ToolInvocation } from '@ziner/contracts';

function inv(toolName: string, args: Record<string, unknown>): ToolInvocation {
  return { id: `test-${toolName}`, toolName, args };
}

function makeGate(rules: AlwaysRule[] = []): ConfirmationGate {
  return new ConfirmationGate({
    onRequest: async () => 'allow',
    rules,
  });
}

describe('ConfirmationGate always-rules', () => {
  it('always-allow rule auto-allows matching tool calls', async () => {
    const gate = makeGate([{
      id: 'r1',
      decision: 'always-allow',
      toolName: 'read_file',
      createdAt: Date.now(),
    }]);
    const decision = await gate.confirm(inv('read_file', { filePath: '/tmp/a.txt' }));
    assert.strictEqual(decision, 'allow');
  });

  it('always-deny rule auto-denies matching tool calls', async () => {
    const gate = makeGate([{
      id: 'r1',
      decision: 'always-deny',
      toolName: 'run_terminal',
      createdAt: Date.now(),
    }]);
    const decision = await gate.confirm(inv('run_terminal', { command: 'ls' }));
    assert.strictEqual(decision, 'deny');
  });

  it('always-allow rule with argPatterns only matches when args match', async () => {
    const gate = makeGate([{
      id: 'r1',
      decision: 'always-allow',
      toolName: 'run_terminal',
      argPatterns: { command: 'git *' },
      createdAt: Date.now(),
    }]);
    assert.strictEqual(await gate.confirm(inv('run_terminal', { command: 'git status' })), 'allow');
    assert.strictEqual(await gate.confirm(inv('run_terminal', { command: 'ls' })), 'allow'); // falls through to UI → allow
  });

  it('persisted always-allow rule includes argPatterns', async () => {
    const persisted: AlwaysRule[] = [];
    const gate = new ConfirmationGate({
      onRequest: async () => 'always-allow',
      onPersistRule: (r) => persisted.push(r),
    });
    await gate.confirm(inv('run_terminal', { command: 'git status' }));
    assert.strictEqual(persisted.length, 1);
    assert.strictEqual(persisted[0].toolName, 'run_terminal');
    assert.strictEqual(persisted[0].decision, 'always-allow');
    assert.ok(persisted[0].argPatterns);
    assert.strictEqual(persisted[0].argPatterns?.command, 'git *');
  });

  it('persisted always-allow for browser_navigate uses scheme+host pattern', async () => {
    const persisted: AlwaysRule[] = [];
    const gate = new ConfirmationGate({
      onRequest: async () => 'always-allow',
      onPersistRule: (r) => persisted.push(r),
    });
    await gate.confirm(inv('browser_navigate', { url: 'http://github.com/foo/bar' }));
    assert.strictEqual(persisted[0].argPatterns?.url, 'http://github.com/*');
  });

  it('persisted always-allow for write_file uses exact filePath', async () => {
    const persisted: AlwaysRule[] = [];
    const gate = new ConfirmationGate({
      onRequest: async () => 'always-allow',
      onPersistRule: (r) => persisted.push(r),
    });
    await gate.confirm(inv('write_file', { filePath: '/tmp/out.txt', content: 'hi' }));
    assert.strictEqual(persisted[0].argPatterns?.filePath, '/tmp/out.txt');
  });

  it('critical risk is blocked even with always-allow rule', async () => {
    const gate = makeGate([{
      id: 'r1',
      decision: 'always-allow',
      toolName: 'run_terminal',
      createdAt: Date.now(),
    }]);
    const decision = await gate.confirm(inv('run_terminal', { command: 'rm -rf /' }));
    assert.strictEqual(decision, 'deny');
  });
});
