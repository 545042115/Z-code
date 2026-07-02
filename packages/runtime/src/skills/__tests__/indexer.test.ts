// @ziner/runtime — in-memory skill indexer tests

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { InMemorySkillIndexer } from '../index';
import type { Skill } from '../skills';

function mkSkill(over: Partial<Skill> = {}): Skill {
  return {
    id: over.id ?? 'sk-1',
    name: over.name ?? 'fixture',
    description: over.description,
    userInvocable: true,
    tags: over.tags ?? [],
    priority: over.priority ?? 50,
    mode: over.mode ?? 'advisory',
    triggers: over.triggers ?? {},
    stopIf: over.stopIf ?? [],
    imports: over.imports ?? [],
    toolsAllow: over.toolsAllow ?? [],
    verification: over.verification ?? {},
    content: over.content ?? '# fixture',
    sections: over.sections ?? {},
    path: over.path ?? `/skills/${over.id ?? 'sk-1'}/SKILL.md`,
    rootDir: over.rootDir ?? `/skills/${over.id ?? 'sk-1'}`,
  };
}

describe('InMemorySkillIndexer', () => {
  it('rebuild populates skillsById and stats', () => {
    const idx = new InMemorySkillIndexer();
    idx.rebuild([
      mkSkill({ id: 'a', triggers: { intents: ['refactor'], keywords: ['code'] }, tags: ['typescript'] }),
      mkSkill({ id: 'b', triggers: { intents: ['test'], keywords: ['vitest'] }, tags: ['testing'] }),
    ]);
    const stats = idx.stats();
    assert.strictEqual(stats.skillCount, 2);
    assert.strictEqual(stats.intentCount, 2);
    assert.strictEqual(stats.keywordCount, 2);
    assert.strictEqual(stats.tagCount, 2);
  });

  it('searches by intent token', () => {
    const idx = new InMemorySkillIndexer();
    idx.rebuild([
      mkSkill({ id: 'a', triggers: { intents: ['refactor'] } }),
      mkSkill({ id: 'b', triggers: { intents: ['test'] } }),
    ]);
    const hits = idx.search('please refactor this', 5);
    assert.strictEqual(hits.length, 1);
    assert.strictEqual(hits[0].id, 'a');
  });

  it('upsert replaces an existing entry', () => {
    const idx = new InMemorySkillIndexer();
    idx.upsert(mkSkill({ id: 'a', triggers: { intents: ['refactor'] } }));
    idx.upsert(mkSkill({ id: 'a', triggers: { intents: ['cleanup'] } }));
    assert.strictEqual(idx.search('refactor', 5).length, 0);
    assert.strictEqual(idx.search('cleanup', 5).length, 1);
    assert.strictEqual(idx.stats().skillCount, 1);
  });

  it('remove drops a skill from the index', () => {
    const idx = new InMemorySkillIndexer();
    idx.upsert(mkSkill({ id: 'a', triggers: { intents: ['refactor'] }, tags: ['typescript'] }));
    idx.remove('a');
    assert.strictEqual(idx.search('refactor', 5).length, 0);
    assert.strictEqual(idx.stats().skillCount, 0);
    assert.strictEqual(idx.stats().intentCount, 0);
    assert.strictEqual(idx.stats().tagCount, 0);
  });

  it('returns top-K skills ranked by signal strength', () => {
    const idx = new InMemorySkillIndexer();
    idx.rebuild([
      mkSkill({ id: 'a', triggers: { intents: ['refactor'] } }), // 50
      mkSkill({ id: 'b', tags: ['refactor'] }),                  // 5
      mkSkill({ id: 'c', triggers: { keywords: ['refactor'] } }),// 10
    ]);
    const hits = idx.search('refactor', 2);
    assert.strictEqual(hits.length, 2);
    assert.strictEqual(hits[0].id, 'a');
    assert.strictEqual(hits[1].id, 'c');
  });
});
