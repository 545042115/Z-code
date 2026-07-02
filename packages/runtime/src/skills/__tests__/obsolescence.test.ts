// @ziner/runtime — obsolescence detector tests

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { tmpdir } from 'os';
import { join } from 'path';
import { rmSync, mkdirSync, existsSync } from 'fs';
import {
  HeuristicObsolescenceDetector,
  JsonFileSkillVersionRegistry,
  JsonlFailureCaseStore,
} from '../index';
import type { Skill } from '../skills';
import type { FailureCase } from '@ziner/contracts';

function makeTempDir(): string {
  const dir = join(tmpdir(), `z-obsolescence-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  if (existsSync(dir)) rmSync(dir, { recursive: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

function mkSkill(id: string, name: string): Skill {
  return {
    id,
    name,
    userInvocable: true,
    tags: [],
    priority: 50,
    mode: 'advisory',
    triggers: {},
    stopIf: [],
    imports: [],
    toolsAllow: [],
    verification: {},
    content: '# skill',
    sections: {},
    path: `/skills/${id}/SKILL.md`,
    rootDir: `/skills/${id}`,
  };
}

function fc(over: Partial<FailureCase> = {}): FailureCase {
  return {
    id: over.id ?? `fc-${Math.random().toString(36).slice(2)}`,
    timestamp: over.timestamp ?? Date.now(),
    runId: over.runId ?? 'r',
    agent: over.agent ?? 'planner',
    task: over.task ?? 't',
    errorCode: over.errorCode ?? '3001',
    errorMessage: over.errorMessage ?? 'oops',
    errorPattern: over.errorPattern ?? 'oops',
  };
}

describe('HeuristicObsolescenceDetector', () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('flags low-success-rate when failures exceed minSample', async () => {
    const versions = new JsonFileSkillVersionRegistry({ rootDir: dir });
    const failureStore = new JsonlFailureCaseStore({ rootDir: dir });
    await versions.push({
      skillId: 's1',
      version: 1,
      createdAt: Date.now(),
      source: 'discovery',
      status: 'active',
      body: 'b',
    });
    for (let i = 0; i < 5; i++) {
      await failureStore.record(fc({ id: `f${i}`, agent: 'planner' }));
    }
    await failureStore.flush();

    const detector = new HeuristicObsolescenceDetector({
      versions,
      failureStore,
      minSample: 3,
      lowSuccessThreshold: 0.5,
    });
    const reports = await detector.scan({
      skills: [mkSkill('s1', 'planner')],
      recentUsage: new Map([['s1', 1]]),
    });
    assert.strictEqual(reports.length, 1);
    assert.strictEqual(reports[0].skillId, 's1');
    assert.ok(reports[0].reasons.some((r) => r.type === 'low-success-rate'));
    assert.strictEqual(reports[0].suggestedAction, 'replace');
  });

  it('flags stale active versions', async () => {
    const versions = new JsonFileSkillVersionRegistry({ rootDir: dir });
    const failureStore = new JsonlFailureCaseStore({ rootDir: dir });
    await versions.push({
      skillId: 's1',
      version: 1,
      createdAt: Date.now() - 60 * 24 * 60 * 60 * 1000, // 60 days ago
      source: 'discovery',
      status: 'active',
      body: 'b',
    });
    const detector = new HeuristicObsolescenceDetector({
      versions,
      failureStore,
      staleThresholdMs: 30 * 24 * 60 * 60 * 1000,
      minSample: 100,
    });
    const reports = await detector.scan({ skills: [mkSkill('s1', 'planner')] });
    assert.strictEqual(reports.length, 1);
    assert.ok(reports[0].reasons.some((r) => r.type === 'stale'));
  });

  it('returns an empty array for empty input', async () => {
    const versions = new JsonFileSkillVersionRegistry({ rootDir: dir });
    const failureStore = new JsonlFailureCaseStore({ rootDir: dir });
    const detector = new HeuristicObsolescenceDetector({ versions, failureStore });
    const reports = await detector.scan({ skills: [] });
    assert.deepStrictEqual(reports, []);
  });
});
