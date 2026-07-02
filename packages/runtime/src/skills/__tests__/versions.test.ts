// @ziner/runtime — skill version registry tests

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { tmpdir } from 'os';
import { join } from 'path';
import { rmSync, mkdirSync, existsSync } from 'fs';
import {
  JsonFileSkillVersionRegistry,
  NoopSkillVersionRegistry,
} from '../index';
import type { SkillVersion } from '@ziner/contracts';

function makeTempDir(): string {
  const dir = join(tmpdir(), `z-skill-versions-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  if (existsSync(dir)) rmSync(dir, { recursive: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

function v(skillId: string, version: number, status: SkillVersion['status'] = 'inactive'): SkillVersion {
  return {
    skillId,
    version,
    createdAt: Date.now() - (10 - version) * 1000,
    source: 'discovery',
    status,
    body: `body v${version}`,
  };
}

describe('JsonFileSkillVersionRegistry', () => {
  let dir: string;
  let reg: JsonFileSkillVersionRegistry;

  beforeEach(() => {
    dir = makeTempDir();
    reg = new JsonFileSkillVersionRegistry({ rootDir: dir });
  });

  afterEach(async () => {
    await reg.flush();
    rmSync(dir, { recursive: true, force: true });
  });

  it('push + list returns the saved versions', async () => {
    await reg.push(v('s1', 1, 'active'));
    await reg.push(v('s1', 2, 'inactive'));
    await reg.flush();
    const all = await reg.list('s1');
    assert.strictEqual(all.length, 2);
    assert.strictEqual(all[0].version, 1);
  });

  it('getActive returns the active version', async () => {
    await reg.push(v('s1', 1, 'inactive'));
    await reg.push(v('s1', 2, 'active'));
    await reg.flush();
    const active = await reg.getActive('s1');
    assert.ok(active);
    assert.strictEqual(active!.version, 2);
  });

  it('activate switches the active version', async () => {
    await reg.push(v('s1', 1, 'active'));
    await reg.push(v('s1', 2, 'inactive'));
    await reg.activate('s1', 2);
    await reg.flush();
    const active = await reg.getActive('s1');
    assert.strictEqual(active?.version, 2);
    const list = await reg.list('s1');
    assert.strictEqual(list.find((x) => x.version === 1)?.status, 'inactive');
  });

  it('rollback returns the previous active version', async () => {
    await reg.push(v('s1', 1, 'inactive'));
    await reg.push(v('s1', 2, 'active'));
    const prev = await reg.rollback('s1');
    assert.ok(prev);
    assert.strictEqual(prev!.version, 1);
    const active = await reg.getActive('s1');
    assert.strictEqual(active?.version, 1);
  });

  it('markObsolete updates status and stores reason', async () => {
    await reg.push(v('s1', 1, 'active'));
    await reg.markObsolete('s1', 1, 'verification failed');
    await reg.flush();
    const list = await reg.list('s1');
    assert.strictEqual(list[0].status, 'obsolete');
    const prov = list[0].provenance as { obsoleteReason?: string } | undefined;
    assert.strictEqual(prov?.obsoleteReason, 'verification failed');
  });

  it('persists across instances', async () => {
    await reg.push(v('s1', 1, 'active'));
    await reg.push(v('s1', 2, 'inactive'));
    await reg.flush();
    const reloaded = new JsonFileSkillVersionRegistry({ rootDir: dir });
    const list = await reloaded.list('s1');
    assert.strictEqual(list.length, 2);
  });
});

describe('NoopSkillVersionRegistry', () => {
  it('returns empty / null for all operations', async () => {
    const reg = new NoopSkillVersionRegistry();
    await reg.push(v('s1', 1, 'active'));
    assert.deepStrictEqual(await reg.list('s1'), []);
    assert.strictEqual(await reg.getActive('s1'), null);
    assert.strictEqual(await reg.rollback('s1'), null);
  });
});
