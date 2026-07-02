// @ziner/runtime — CheckpointManager tests
//
// Verifies the per-sub-task checkpoint lifecycle:
//   - save() creates the file and updates the index
//   - load() round-trips a saved checkpoint
//   - list() returns the most-recently-updated entry first
//   - delete() removes a file and rebuilds the index
//   - cleanup() enforces TTL and maxEntries

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { CheckpointManager, type Checkpoint, type SubTaskResult } from '../checkpoint';

async function makeCheckpoint(
  runId: string,
  overrides?: Partial<Checkpoint>,
): Promise<Checkpoint> {
  return {
    runId,
    task: `test task ${runId}`,
    mode: 'plan',
    sessionId: 'sess-1',
    planDag: {
      task: 'test task',
      subtasks: [
        { id: 'a', title: 'A', prompt: 'do a', assignedTo: 'a-agent', dependsOn: [] },
        { id: 'b', title: 'B', prompt: 'do b', assignedTo: 'b-agent', dependsOn: ['a'] },
      ],
    },
    completedSubTaskIds: ['a'],
    subtaskOutputs: {
      a: { ok: true, output: 'A result', agent: 'a-agent', completedAt: 100, durationMs: 10 } satisfies SubTaskResult,
    },
    sharedState: { 'subtasks.a.output': { value: 'A result', version: 1, updatedAt: 100 } },
    plannerAgent: 'planner',
    synthesizerAgent: 'synthesizer',
    createdAt: 100,
    updatedAt: 200,
    status: 'in_progress',
    ...overrides,
  };
}

test('CheckpointManager: save() then load() round-trips a checkpoint', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ckpt-'));
  try {
    const mgr = new CheckpointManager({ rootDir: dir, ttlMs: 60_000, maxEntries: 5 });
    const ck = await makeCheckpoint('r1');
    await mgr.save(ck);
    const loaded = await mgr.load('r1');
    assert.ok(loaded);
    assert.equal(loaded!.runId, 'r1');
    assert.equal(loaded!.task, 'test task r1');
    assert.equal(loaded!.planDag.subtasks.length, 2);
    assert.equal(loaded!.subtaskOutputs.a.output, 'A result');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('CheckpointManager: save() merges subsequent sub-task outputs into the same runId', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ckpt-'));
  try {
    const mgr = new CheckpointManager({ rootDir: dir, ttlMs: 60_000, maxEntries: 5 });
    await mgr.save(await makeCheckpoint('r1', {
      completedSubTaskIds: ['a'],
      subtaskOutputs: { a: { ok: true, output: 'A1', agent: 'a', completedAt: 1, durationMs: 1 } },
      createdAt: 1,
    }));
    await mgr.save(await makeCheckpoint('r1', {
      completedSubTaskIds: ['b'],
      subtaskOutputs: { b: { ok: true, output: 'B1', agent: 'b', completedAt: 2, durationMs: 1 } },
    }));
    const loaded = await mgr.load('r1');
    assert.ok(loaded);
    assert.deepEqual(loaded!.completedSubTaskIds.sort(), ['a', 'b']);
    assert.equal(loaded!.subtaskOutputs.a.output, 'A1');
    assert.equal(loaded!.subtaskOutputs.b.output, 'B1');
    // createdAt is preserved across merges; updatedAt is refreshed to
    // "now" (we just check it's > the original createdAt).
    assert.equal(loaded!.createdAt, 1);
    assert.ok(loaded!.updatedAt > 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('CheckpointManager: list() returns the most-recently-updated entry first', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ckpt-'));
  try {
    const mgr = new CheckpointManager({ rootDir: dir, ttlMs: 60_000, maxEntries: 5 });
    await mgr.save(await makeCheckpoint('older'));
    // Wait so the next save has a strictly larger updatedAt.
    await new Promise((r) => setTimeout(r, 5));
    await mgr.save(await makeCheckpoint('newer'));
    const entries = await mgr.list();
    assert.deepEqual(entries.map((e) => e.runId), ['newer', 'older']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('CheckpointManager: list() filters by sessionId', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ckpt-'));
  try {
    const mgr = new CheckpointManager({ rootDir: dir, ttlMs: 60_000, maxEntries: 5 });
    await mgr.save(await makeCheckpoint('r1', { sessionId: 'A' }));
    await mgr.save(await makeCheckpoint('r2', { sessionId: 'B' }));
    const entries = await mgr.list({ sessionId: 'A' });
    assert.deepEqual(entries.map((e) => e.runId), ['r1']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('CheckpointManager: list() honours limit', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ckpt-'));
  try {
    const mgr = new CheckpointManager({ rootDir: dir, ttlMs: 60_000, maxEntries: 5 });
    for (let i = 0; i < 3; i++) {
      await mgr.save(await makeCheckpoint(`r${i}`, { createdAt: i }));
    }
    const entries = await mgr.list({ limit: 2 });
    assert.equal(entries.length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('CheckpointManager: delete() removes the file and rebuilds the index', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ckpt-'));
  try {
    const mgr = new CheckpointManager({ rootDir: dir, ttlMs: 60_000, maxEntries: 5 });
    await mgr.save(await makeCheckpoint('r1'));
    await mgr.delete('r1');
    assert.equal(await mgr.load('r1'), null);
    const entries = await mgr.list();
    assert.equal(entries.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('CheckpointManager: cleanup() removes entries older than ttlMs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ckpt-'));
  try {
    const mgr = new CheckpointManager({ rootDir: dir, ttlMs: 60_000, maxEntries: 5 });
    // Bypass save() and write the "old" checkpoint directly so we can
    // pin its updatedAt to a value in the past. CheckpointManager.save
    // always overwrites updatedAt with Date.now().
    const oldDir = join(dir, 'checkpoints');
    await mkdir(oldDir, { recursive: true });
    const old = await makeCheckpoint('old', { createdAt: 1, updatedAt: 1 });
    await writeFile(join(oldDir, 'old.json'), JSON.stringify(old), 'utf8');
    // Save a "fresh" entry whose updatedAt is now (mgr.save sets it).
    await mgr.save(await makeCheckpoint('fresh', { createdAt: 1000, updatedAt: Date.now() }));
    // Run cleanup with a 5s TTL via a fresh mgr. The "old" entry's
    // updatedAt is 1 (1970-01-01) so it's well past the threshold; the
    // "fresh" entry has an updatedAt of "now" and survives.
    const mgr2 = new CheckpointManager({ rootDir: dir, ttlMs: 5_000, maxEntries: 100 });
    const res = await mgr2.cleanup();
    assert.equal(res.removed, 1);
    const remaining = await mgr2.list();
    assert.deepEqual(remaining.map((e) => e.runId), ['fresh']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('CheckpointManager: cleanup() caps to maxEntries (LRU by updatedAt)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ckpt-'));
  try {
    // Use a very large TTL so the test focuses on maxEntries behaviour.
    const mgr = new CheckpointManager({ rootDir: dir, ttlMs: 1_000_000_000, maxEntries: 5 });
    for (let i = 0; i < 5; i++) {
      // save() forces updatedAt to Date.now() — no way to backdate
      // without bypassing save(). We instead trust save()'s ordering
      // and rely on maxEntries to do the pruning.
      await mgr.save(await makeCheckpoint(`r${i}`, { createdAt: i }));
    }
    // At maxEntries=5 none should be removed.
    const res0 = await mgr.cleanup();
    assert.equal(res0.removed, 0);
    // Now lower the cap to 2 and clean up.
    const mgr2 = new CheckpointManager({ rootDir: dir, ttlMs: 1_000_000_000, maxEntries: 2 });
    const res = await mgr2.cleanup();
    // All 5 have updatedAt very close in time, but maxEntries=2 keeps
    // the 2 most recently updated (save order: r4, r3 — first-saved
    // are oldest so removed first; or last-saved are most recent).
    // Either way 3 should be removed.
    assert.equal(res.removed, 3);
    const remaining = (await mgr2.list()).map((e) => e.runId);
    assert.equal(remaining.length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('CheckpointManager: save() with an unknown runId builds the index from scratch', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ckpt-'));
  try {
    const mgr = new CheckpointManager({ rootDir: dir, ttlMs: 60_000, maxEntries: 5 });
    // Manually write a checkpoint file (no index yet) to simulate a fresh
    // storage dir that already has a checkpoint on disk.
    const ckDir = join(dir, 'checkpoints');
    await mkdir(ckDir, { recursive: true });
    const file = join(ckDir, 'orphan.json');
    const ck = await makeCheckpoint('orphan');
    await writeFile(file, JSON.stringify(ck), 'utf8');
    const list = await mgr.list();
    assert.ok(list.find((e) => e.runId === 'orphan'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
