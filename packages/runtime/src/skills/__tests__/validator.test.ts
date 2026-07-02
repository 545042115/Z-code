// @ziner/runtime — candidate skill validator tests

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { validateCandidate } from '../index';
import type { CandidateSkillDraft } from '@ziner/contracts';

function base(over: Partial<CandidateSkillDraft> = {}): CandidateSkillDraft {
  return {
    name: 'auto-planner-3001',
    description: 'mitigate recurring planner failures',
    tags: ['auto-discovered'],
    priority: 40,
    mode: 'advisory',
    triggers: { keywords: ['retry'], intents: ['planner'] },
    body:
      '# Title\n\n## Purpose\nMitigate recurring planner failures.\n\n## Workflow\nFollow each step carefully.\n',
    ...over,
  };
}

describe('validateCandidate', () => {
  it('passes a complete valid draft', () => {
    const res = validateCandidate(base());
    assert.strictEqual(res.valid, true);
    assert.strictEqual(res.issues.filter((i) => i.severity === 'error').length, 0);
  });

  it('flags missing name as an error', () => {
    const res = validateCandidate(base({ name: '' }));
    assert.strictEqual(res.valid, false);
    assert.ok(res.issues.some((i) => i.field === 'name' && i.severity === 'error'));
  });

  it('flags body that is too short as an error', () => {
    const res = validateCandidate(base({ body: 'too short' }));
    assert.strictEqual(res.valid, false);
    assert.ok(res.issues.some((i) => i.field === 'body' && i.severity === 'error'));
  });

  it('warns on a body without enough headings', () => {
    const body = 'lorem ipsum dolor sit amet '.repeat(5);
    const res = validateCandidate(base({ body }));
    // body is long enough but has no headings
    assert.ok(res.issues.some((i) => i.field === 'body' && i.severity === 'warning'));
  });

  it('warns on an invalid priority', () => {
    const res = validateCandidate(base({ priority: 9001 }));
    assert.ok(res.issues.some((i) => i.field === 'priority' && i.severity === 'warning'));
  });

  it('flags empty triggers as an error', () => {
    const res = validateCandidate(base({ triggers: {} }));
    assert.strictEqual(res.valid, false);
    assert.ok(res.issues.some((i) => i.field === 'triggers' && i.severity === 'error'));
  });
});
