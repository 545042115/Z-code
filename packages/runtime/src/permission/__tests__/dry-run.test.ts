// @z-assistant/runtime — DryRunExecutor tests

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { DryRunExecutor } from '../index';
import type { ToolInvocation } from '@z-assistant/contracts';

function inv(toolName: string, args: Record<string, unknown> = {}): ToolInvocation {
  return { id: `test-${toolName}`, toolName, args };
}

describe('DryRunExecutor', () => {
  it('simulates write_file with byte count', async () => {
    const exec = new DryRunExecutor();
    const result = await exec.simulate(inv('write_file', { filePath: '/foo.txt', content: 'hello world' }));
    assert.ok(result.startsWith('[dry-run]'));
    assert.ok(result.includes('11 bytes'));
    assert.ok(result.includes('/foo.txt'));
  });

  it('simulates run_terminal with command', async () => {
    const exec = new DryRunExecutor();
    const result = await exec.simulate(inv('run_terminal', { command: 'git status' }));
    assert.ok(result.includes('git status'));
    assert.ok(result.includes('Would have executed'));
  });

  it('simulates read_file with line range', async () => {
    const exec = new DryRunExecutor();
    const result = await exec.simulate(inv('read_file', { filePath: '/src/app.ts', startLine: 10, lineCount: 5 }));
    assert.ok(result.includes('/src/app.ts'));
    assert.ok(result.includes('lines 10-14'));
  });

  it('simulates web_search with query', async () => {
    const exec = new DryRunExecutor();
    const result = await exec.simulate(inv('web_search', { query: 'typescript tutorial', maxResults: 3 }));
    assert.ok(result.includes('typescript tutorial'));
    assert.ok(result.includes('3 results'));
  });

  it('simulates browser_navigate with url', async () => {
    const exec = new DryRunExecutor();
    const result = await exec.simulate(inv('browser_navigate', { url: 'https://example.com' }));
    assert.ok(result.includes('https://example.com'));
  });

  it('simulates unknown tools with a generic message', async () => {
    const exec = new DryRunExecutor();
    const result = await exec.simulate(inv('custom_tool', { foo: 'bar' }));
    assert.ok(result.includes('custom_tool'));
    assert.ok(result.includes('foo'));
  });

  it('uses custom prefix', async () => {
    const exec = new DryRunExecutor({ prefix: '[preview]' });
    const result = await exec.simulate(inv('read_file', { filePath: '/x' }));
    assert.ok(result.startsWith('[preview]'));
  });

  it('fires onSimulate callback', async () => {
    const captured: { inv?: ToolInvocation; sim?: string } = {};
    const exec = new DryRunExecutor({
      onSimulate: (invocation, simulation) => { captured.inv = invocation; captured.sim = simulation; },
    });
    await exec.simulate(inv('write_file', { filePath: '/x', content: 'y' }));
    assert.ok(captured.inv);
    assert.strictEqual(captured.inv.toolName, 'write_file');
    assert.ok(captured.sim?.startsWith('[dry-run]'));
  });

  it('describe() is usable without await (for UI previews)', () => {
    const exec = new DryRunExecutor();
    const desc = exec.describe('replace_text', { filePath: '/a.txt', oldText: 'foo', newText: 'bar' });
    assert.ok(desc.includes('3 chars'));
    assert.ok(desc.includes('/a.txt'));
  });

  it('handles missing args gracefully', async () => {
    const exec = new DryRunExecutor();
    const result = await exec.simulate(inv('write_file'));
    assert.ok(result.includes('0 bytes'));
  });
});
