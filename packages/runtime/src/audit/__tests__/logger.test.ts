// @z-assistant/runtime — audit logger tests

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { tmpdir } from 'os';
import { join } from 'path';
import { rmSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { AuditLogger, NoopAuditLogger } from '../index';
import type { AuditLogEntry } from '@z-assistant/contracts';

function makeTempDir(): string {
  const dir = join(tmpdir(), `z-assistant-audit-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  if (existsSync(dir)) rmSync(dir, { recursive: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('AuditLogger', () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes entries to audit.jsonl', async () => {
    const logger = new AuditLogger({ rootDir: dir });
    await logger.logPending({
      invocationId: 'inv-1',
      toolName: 'run_terminal',
      args: { command: 'ls' },
      risk: 'high',
      decision: 'allow',
      userId: 'test-user',
    });
    await logger.flush();

    const file = join(dir, 'audit.jsonl');
    assert.ok(existsSync(file), 'audit.jsonl should exist');
    const content = readFileSync(file, 'utf8').trim();
    const entry = JSON.parse(content) as AuditLogEntry;
    assert.strictEqual(entry.invocationId, 'inv-1');
    assert.strictEqual(entry.toolName, 'run_terminal');
    assert.strictEqual(entry.risk, 'high');
    assert.strictEqual(entry.decision, 'allow');
    assert.strictEqual(entry.outcome, 'pending');
    assert.strictEqual(entry.userId, 'test-user');
    assert.ok(entry.id, 'id should be auto-generated');
    assert.ok(entry.timestamp > 0, 'timestamp should be set');
  });

  it('logs outcome entries', async () => {
    const logger = new AuditLogger({ rootDir: dir });
    await logger.logOutcome({
      invocationId: 'inv-2',
      toolName: 'write_file',
      args: { path: '/tmp/test.txt' },
      risk: 'medium',
      outcome: 'success',
      durationMs: 42,
    });
    await logger.flush();

    const entries = await logger.list({ limit: 10 });
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].outcome, 'success');
    assert.strictEqual(entries[0].durationMs, 42);
  });

  it('lists entries newest-first', async () => {
    const logger = new AuditLogger({ rootDir: dir });
    for (let i = 0; i < 5; i++) {
      await logger.log({
        invocationId: `inv-${i}`,
        toolName: 'read_file',
        args: {},
        risk: 'safe',
        outcome: 'success',
        timestamp: 1000 + i,
      });
    }
    await logger.flush();

    const entries = await logger.list({ limit: 3 });
    assert.strictEqual(entries.length, 3);
    // Newest first → inv-4, inv-3, inv-2
    assert.strictEqual(entries[0].invocationId, 'inv-4');
    assert.strictEqual(entries[1].invocationId, 'inv-3');
    assert.strictEqual(entries[2].invocationId, 'inv-2');
  });

  it('filters by runId', async () => {
    const logger = new AuditLogger({ rootDir: dir });
    await logger.log({ invocationId: 'a', toolName: 't', args: {}, risk: 'low', outcome: 'success', runId: 'run-A' });
    await logger.log({ invocationId: 'b', toolName: 't', args: {}, risk: 'low', outcome: 'success', runId: 'run-B' });
    await logger.log({ invocationId: 'c', toolName: 't', args: {}, risk: 'low', outcome: 'success', runId: 'run-A' });
    await logger.flush();

    const runA = await logger.list({ runId: 'run-A' });
    assert.strictEqual(runA.length, 2);
    assert.ok(runA.every((e) => e.runId === 'run-A'));
  });

  it('filters by toolName and outcome', async () => {
    const logger = new AuditLogger({ rootDir: dir });
    await logger.log({ invocationId: '1', toolName: 'read_file', args: {}, risk: 'safe', outcome: 'success' });
    await logger.log({ invocationId: '2', toolName: 'write_file', args: {}, risk: 'medium', outcome: 'error', errorMessage: 'disk full' });
    await logger.log({ invocationId: '3', toolName: 'write_file', args: {}, risk: 'medium', outcome: 'success' });
    await logger.flush();

    const writes = await logger.list({ toolName: 'write_file' });
    assert.strictEqual(writes.length, 2);

    const errors = await logger.list({ outcome: 'error' });
    assert.strictEqual(errors.length, 1);
    assert.strictEqual(errors[0].errorMessage, 'disk full');
  });

  it('filters by time range', async () => {
    const logger = new AuditLogger({ rootDir: dir });
    await logger.log({ invocationId: 'old', toolName: 't', args: {}, risk: 'safe', outcome: 'success', timestamp: 1000 });
    await logger.log({ invocationId: 'mid', toolName: 't', args: {}, risk: 'safe', outcome: 'success', timestamp: 2000 });
    await logger.log({ invocationId: 'new', toolName: 't', args: {}, risk: 'safe', outcome: 'success', timestamp: 3000 });
    await logger.flush();

    const range = await logger.list({ since: 1500, until: 2500 });
    assert.strictEqual(range.length, 1);
    assert.strictEqual(range[0].invocationId, 'mid');
  });

  it('counts entries', async () => {
    const logger = new AuditLogger({ rootDir: dir });
    for (let i = 0; i < 10; i++) {
      await logger.log({ invocationId: `inv-${i}`, toolName: 't', args: {}, risk: 'safe', outcome: 'success' });
    }
    await logger.flush();

    const count = await logger.count();
    assert.strictEqual(count, 10);
  });

  it('works in no-op mode without rootDir', async () => {
    const logger = new AuditLogger();
    await logger.log({ invocationId: 'x', toolName: 't', args: {}, risk: 'safe', outcome: 'success' });
    await logger.flush();

    const entries = await logger.list();
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].invocationId, 'x');
  });

  it('NoopAuditLogger returns empty results', async () => {
    const logger = new NoopAuditLogger();
    await logger.logPending({ invocationId: 'x', toolName: 't', args: {}, risk: 'safe' });
    const entries = await logger.list();
    assert.strictEqual(entries.length, 0);
    const count = await logger.count();
    assert.strictEqual(count, 0);
  });

  it('persists across logger instances (append-only)', async () => {
    const file = join(dir, 'audit.jsonl');

    const logger1 = new AuditLogger({ rootDir: dir });
    await logger1.log({ invocationId: 'first', toolName: 't', args: {}, risk: 'safe', outcome: 'success' });
    await logger1.flush();

    const logger2 = new AuditLogger({ rootDir: dir });
    await logger2.log({ invocationId: 'second', toolName: 't', args: {}, risk: 'safe', outcome: 'success' });
    await logger2.flush();

    const entries = await logger2.list({ limit: 100 });
    assert.strictEqual(entries.length, 2);
  });
});
