// @ziner/runtime — auto-discovery engine end-to-end tests

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { tmpdir } from 'os';
import { join } from 'path';
import { rmSync, mkdirSync, existsSync } from 'fs';
import {
  AutoDiscoveryEngine,
  JsonlFailureCaseStore,
  JsonFileSkillReviewQueue,
  TemplateSkillExtractor,
  NoopFailureCaseStore,
} from '../index';
import type { CandidateSkillDraft, FailureCase } from '@ziner/contracts';

function makeTempDir(): string {
  const dir = join(tmpdir(), `z-auto-discovery-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  if (existsSync(dir)) rmSync(dir, { recursive: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

function fc(over: Partial<FailureCase> = {}): FailureCase {
  return {
    id: over.id ?? `fc-${Math.random().toString(36).slice(2)}`,
    timestamp: over.timestamp ?? Date.now(),
    runId: over.runId ?? 'r1',
    agent: over.agent ?? 'planner',
    task: over.task ?? 'task',
    errorCode: over.errorCode ?? '3001',
    errorMessage: over.errorMessage ?? 'something failed',
    errorPattern: over.errorPattern ?? 'something failed',
    toolName: over.toolName,
  };
}

describe('AutoDiscoveryEngine', () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('produces a candidate from recurring failures and enqueues it', async () => {
    const store = new JsonlFailureCaseStore({ rootDir: dir });
    const queue = new JsonFileSkillReviewQueue({ rootDir: dir });
    await store.record(fc({ id: 'a' }));
    await store.record(fc({ id: 'b' }));
    await store.record(fc({ id: 'c' }));
    await store.flush();

    const engine = new AutoDiscoveryEngine({
      failureStore: store,
      extractor: new TemplateSkillExtractor(),
      reviewQueue: queue,
    });
    const report = await engine.discover({ minOccurrences: 2 });
    assert.strictEqual(report.proposedCandidates.length, 1);
    assert.strictEqual(report.scannedCases, 3);
    const pending = await queue.listPending();
    assert.strictEqual(pending.length, 1);
    assert.strictEqual(pending[0].status, 'pending');
    assert.strictEqual(pending[0].draft.name, 'auto-planner-3001');
  });

  it('skips groups below minOccurrences', async () => {
    const store = new JsonlFailureCaseStore({ rootDir: dir });
    const queue = new JsonFileSkillReviewQueue({ rootDir: dir });
    await store.record(fc({ id: 'lonely' }));
    await store.flush();
    const engine = new AutoDiscoveryEngine({
      failureStore: store,
      extractor: new TemplateSkillExtractor(),
      reviewQueue: queue,
    });
    const report = await engine.discover({ minOccurrences: 2 });
    assert.strictEqual(report.proposedCandidates.length, 0);
    assert.strictEqual(report.skipped.length, 1);
    assert.match(report.skipped[0].reason, /minOccurrences/);
  });

  it('routes invalid drafts to skipped rather than enqueueing them', async () => {
    const store = new JsonlFailureCaseStore({ rootDir: dir });
    const queue = new JsonFileSkillReviewQueue({ rootDir: dir });
    await store.record(fc({ id: 'a' }));
    await store.record(fc({ id: 'b' }));
    await store.flush();

    // Force every draft to be invalid.
    const engine = new AutoDiscoveryEngine({
      failureStore: store,
      extractor: new TemplateSkillExtractor(),
      reviewQueue: queue,
      validator: (_draft: CandidateSkillDraft) => ({
        valid: false,
        issues: [{ severity: 'error', message: 'forced invalid' }],
      }),
    });
    const report = await engine.discover({ minOccurrences: 2 });
    assert.strictEqual(report.proposedCandidates.length, 0);
    assert.strictEqual(report.skipped.length, 1);
    assert.match(report.skipped[0].reason, /forced invalid/);
    const pending = await queue.listPending();
    assert.strictEqual(pending.length, 0);
  });

  it('returns an empty report for an empty store', async () => {
    const queue = new JsonFileSkillReviewQueue({ rootDir: dir });
    const engine = new AutoDiscoveryEngine({
      failureStore: new NoopFailureCaseStore(),
      extractor: new TemplateSkillExtractor(),
      reviewQueue: queue,
    });
    const report = await engine.discover({ minOccurrences: 2 });
    assert.strictEqual(report.scannedCases, 0);
    assert.strictEqual(report.scannedGroups, 0);
    assert.strictEqual(report.proposedCandidates.length, 0);
    assert.strictEqual(report.skipped.length, 0);
  });
});
