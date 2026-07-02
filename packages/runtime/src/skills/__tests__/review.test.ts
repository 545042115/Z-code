// @ziner/runtime — skill review queue tests

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { tmpdir } from 'os';
import { join } from 'path';
import { rmSync, mkdirSync, existsSync } from 'fs';
import { JsonFileSkillReviewQueue } from '../index';
import type { CandidateSkill } from '@ziner/contracts';

function makeTempDir(): string {
  const dir = join(tmpdir(), `z-skill-review-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  if (existsSync(dir)) rmSync(dir, { recursive: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

function mkCandidate(id: string): CandidateSkill {
  return {
    id,
    proposedAt: Date.now(),
    sourceGroupKey: 'k',
    sourceCaseIds: ['c1'],
    draft: {
      name: id,
      description: 'd',
      tags: ['auto-discovered'],
      priority: 40,
      mode: 'advisory',
      triggers: { keywords: ['x'] },
      body: '# t\n## Purpose\nbody',
    },
    confidence: 0.5,
    status: 'pending',
  };
}

describe('JsonFileSkillReviewQueue', () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('enqueue + listPending returns pending candidates', async () => {
    const q = new JsonFileSkillReviewQueue({ rootDir: dir });
    await q.enqueue(mkCandidate('a'));
    await q.enqueue(mkCandidate('b'));
    await q.flush();
    const pending = await q.listPending();
    assert.strictEqual(pending.length, 2);
  });

  it('approve marks status=approved and fires onApprove', async () => {
    let approvedId: string | undefined;
    const q = new JsonFileSkillReviewQueue({
      rootDir: dir,
      onApprove: async (c) => {
        approvedId = c.id;
      },
    });
    await q.enqueue(mkCandidate('a'));
    const c = await q.approve('a', { reviewer: 'me', note: 'lgtm' });
    assert.strictEqual(c.status, 'approved');
    assert.strictEqual(c.reviewedBy, 'me');
    assert.strictEqual(c.reviewNote, 'lgtm');
    assert.strictEqual(approvedId, 'a');
    const pending = await q.listPending();
    assert.strictEqual(pending.length, 0);
  });

  it('reject marks status=rejected and fires onReject', async () => {
    let rejectedId: string | undefined;
    const q = new JsonFileSkillReviewQueue({
      rootDir: dir,
      onReject: async (c) => {
        rejectedId = c.id;
      },
    });
    await q.enqueue(mkCandidate('a'));
    const c = await q.reject('a', { reviewer: 'me', note: 'nope' });
    assert.strictEqual(c.status, 'rejected');
    assert.strictEqual(rejectedId, 'a');
  });

  it('get returns null for an unknown id', async () => {
    const q = new JsonFileSkillReviewQueue({ rootDir: dir });
    assert.strictEqual(await q.get('missing'), null);
  });

  it('persists across instances', async () => {
    const q1 = new JsonFileSkillReviewQueue({ rootDir: dir });
    await q1.enqueue(mkCandidate('a'));
    await q1.flush();
    const q2 = new JsonFileSkillReviewQueue({ rootDir: dir });
    const c = await q2.get('a');
    assert.ok(c);
    assert.strictEqual(c!.id, 'a');
  });
});
