// @z-assistant/runtime — local community skill store tests

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { tmpdir } from 'os';
import { join } from 'path';
import { rmSync, mkdirSync, existsSync } from 'fs';
import { LocalCommunitySkillStore } from '../index';
import type { Skill } from '../skills';

function makeTempDir(): string {
  const dir = join(tmpdir(), `z-community-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  if (existsSync(dir)) rmSync(dir, { recursive: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

function mkSkill(id: string, name: string): Skill {
  return {
    id,
    name,
    description: 'desc',
    userInvocable: true,
    tags: ['typescript'],
    priority: 50,
    mode: 'advisory',
    triggers: { intents: [name] },
    stopIf: [],
    imports: [],
    toolsAllow: [],
    verification: {},
    content: `# ${name}\n\nbody`,
    sections: {},
    path: `/skills/${id}/SKILL.md`,
    rootDir: `/skills/${id}`,
  };
}

describe('LocalCommunitySkillStore', () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('publishes a skill and lists it back', async () => {
    const store = new LocalCommunitySkillStore({ rootDir: dir, publisher: 'tester' });
    const res = await store.publish(mkSkill('a', 'alpha'), { source: 'user' });
    assert.ok(res.id);
    assert.ok(res.url?.startsWith('file://'));
    const list = await store.list();
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].name, 'alpha');
    assert.strictEqual(list[0].publisher, 'tester');
  });

  it('pulls a published skill back as a full Skill record', async () => {
    const store = new LocalCommunitySkillStore({ rootDir: dir });
    const res = await store.publish(mkSkill('a', 'alpha'));
    const pulled = await store.pull(res.id);
    assert.strictEqual(pulled.name, 'alpha');
    assert.strictEqual(pulled.mode, 'advisory');
    assert.ok(pulled.content.includes('alpha'));
  });

  it('empty store list returns []', async () => {
    const store = new LocalCommunitySkillStore({ rootDir: dir });
    assert.deepStrictEqual(await store.list(), []);
  });
});
