// @ziner/runtime — skill composition engine tests

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { CooccurrenceCompositionEngine } from '../index';
import type { SelectedSkill, SkillSpec } from '@ziner/contracts';

function spec(id: string, name: string): SkillSpec {
  return {
    id,
    name,
    tags: [],
    triggers: { intents: [name] },
    priority: 50,
    mode: 'advisory',
    body: `# ${name}\n\n## Purpose\nDo ${name}.`,
  };
}

function sel(spec: SkillSpec): SelectedSkill {
  return {
    skill: spec,
    score: 10,
    reasons: [],
  };
}

describe('CooccurrenceCompositionEngine', () => {
  it('emits a proposal when two skills co-occur strongly', async () => {
    const a = spec('a', 'alpha');
    const b = spec('b', 'beta');
    const engine = new CooccurrenceCompositionEngine();
    const proposals = await engine.propose({
      recentSelections: [
        [sel(a), sel(b)],
        [sel(a), sel(b)],
        [sel(a), sel(b)],
      ],
    });
    assert.strictEqual(proposals.length, 1);
    assert.deepStrictEqual([...proposals[0].partIds].sort(), ['a', 'b']);
    assert.ok(proposals[0].draft.name.startsWith('compose-'));
    assert.ok(proposals[0].cooccurrence >= 0.5);
  });

  it('skips pairs whose co-occurrence is below the threshold', async () => {
    const a = spec('a', 'alpha');
    const b = spec('b', 'beta');
    const c = spec('c', 'gamma');
    const engine = new CooccurrenceCompositionEngine();
    // a appears 5x, b appears 5x, but together only once.
    const proposals = await engine.propose({
      recentSelections: [
        [sel(a)],
        [sel(a)],
        [sel(a)],
        [sel(a)],
        [sel(a), sel(b)],
        [sel(b)],
        [sel(b)],
        [sel(b)],
        [sel(b)],
        [sel(c)],
      ],
      minCooccurrence: 0.5,
      minSessions: 3,
    });
    assert.strictEqual(proposals.length, 0);
  });

  it('returns an empty array for empty input', async () => {
    const engine = new CooccurrenceCompositionEngine();
    const proposals = await engine.propose({ recentSelections: [] });
    assert.deepStrictEqual(proposals, []);
  });
});
