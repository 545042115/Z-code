// @ziner/runtime — LLM skill extractor tests

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  TemplateSkillExtractor,
  LLMSkillExtractor,
  validateExtractedDraft,
  extractToCandidate,
} from '../index';
import type {
  FailureGroup,
  FailureCase,
  ILLMProvider,
  LLMResponse,
} from '@ziner/contracts';

function mkGroup(over: Partial<FailureGroup> = {}): FailureGroup {
  const cases: FailureCase[] = over.cases ?? [
    {
      id: 'c1',
      timestamp: 1,
      runId: 'r1',
      agent: 'planner',
      task: 'do thing',
      errorCode: '3001',
      errorMessage: 'tool args invalid',
      errorPattern: 'tool args invalid',
      toolName: 'edit',
    },
    {
      id: 'c2',
      timestamp: 2,
      runId: 'r2',
      agent: 'planner',
      task: 'do thing 2',
      errorCode: '3001',
      errorMessage: 'tool args invalid',
      errorPattern: 'tool args invalid',
      toolName: 'edit',
    },
  ];
  return {
    key: 'planner|3001|tool args invalid',
    agent: 'planner',
    errorCode: '3001',
    errorPattern: 'tool args invalid',
    cases,
    firstSeen: 1,
    lastSeen: 2,
    toolNames: ['edit'],
    ...over,
  };
}

function makeProvider(impl: (req: unknown) => Promise<LLMResponse> | LLMResponse): ILLMProvider {
  return {
    name: 'mock',
    supportedModels: ['mock-1'],
    async generate(req) {
      return Promise.resolve(impl(req));
    },
  };
}

describe('TemplateSkillExtractor', () => {
  it('produces a valid draft with expected name and tags', async () => {
    const extractor = new TemplateSkillExtractor();
    const draft = await extractor.extract(mkGroup());
    assert.strictEqual(draft.name, 'auto-planner-3001');
    assert.strictEqual(draft.mode, 'advisory');
    assert.strictEqual(draft.priority, 40);
    assert.ok(draft.tags.includes('auto-discovered'));
    assert.ok(draft.tags.includes('planner'));
    assert.ok(draft.tags.includes('3001'));
    assert.ok(draft.tags.includes('edit'));
    assert.ok(draft.body.includes('## Purpose'));
    assert.ok(draft.body.includes('## Workflow'));
  });

  it('derives deduped keywords sliced to top 5 from the error pattern', async () => {
    const extractor = new TemplateSkillExtractor();
    const draft = await extractor.extract(
      mkGroup({ errorPattern: 'alpha beta gamma alpha delta epsilon zeta eta theta' })
    );
    const kw = draft.triggers.keywords ?? [];
    assert.ok(kw.length <= 5);
    assert.strictEqual(new Set(kw).size, kw.length);
    assert.ok(kw.includes('alpha'));
  });
});

describe('extractToCandidate', () => {
  it('builds a CandidateSkill with status=pending and source data', async () => {
    const extractor = new TemplateSkillExtractor();
    const group = mkGroup();
    const cand = await extractToCandidate(group, extractor, { confidence: 0.7 });
    assert.strictEqual(cand.status, 'pending');
    assert.strictEqual(cand.confidence, 0.7);
    assert.strictEqual(cand.sourceGroupKey, group.key);
    assert.deepStrictEqual(cand.sourceCaseIds, ['c1', 'c2']);
    assert.ok(cand.id);
    assert.ok(cand.proposedAt > 0);
    assert.strictEqual(cand.draft.name, 'auto-planner-3001');
  });
});

describe('LLMSkillExtractor', () => {
  const model = { provider: 'mock', name: 'mock-1' };

  it('uses a valid JSON response from the LLM', async () => {
    const draftJson = {
      name: 'llm-skill',
      description: 'A drafted skill',
      tags: ['auto-discovered', 'planner'],
      priority: 35,
      mode: 'advisory',
      triggers: { intents: ['planner'], keywords: ['retry'] },
      body: '# Title\n\n## Purpose\nDo the thing.\n\n## Workflow\nStep one.\n',
    };
    const llm = makeProvider(() => ({
      message: { role: 'assistant', content: JSON.stringify(draftJson) },
      usage: { tokensIn: 0, tokensOut: 0 },
      durationMs: 0,
      finishReason: 'end_turn',
    }));
    const extractor = new LLMSkillExtractor({ llm, model });
    const draft = await extractor.extract(mkGroup());
    assert.strictEqual(draft.name, 'llm-skill');
    assert.strictEqual(draft.priority, 35);
    assert.deepStrictEqual(draft.triggers.intents, ['planner']);
  });

  it('falls back to the template extractor on invalid JSON', async () => {
    const llm = makeProvider(() => ({
      message: { role: 'assistant', content: 'not json at all' },
      usage: { tokensIn: 0, tokensOut: 0 },
      durationMs: 0,
      finishReason: 'end_turn',
    }));
    const extractor = new LLMSkillExtractor({ llm, model });
    const draft = await extractor.extract(mkGroup());
    assert.strictEqual(draft.name, 'auto-planner-3001');
  });

  it('falls back when the provider throws', async () => {
    const llm = makeProvider(() => {
      throw new Error('boom');
    });
    const extractor = new LLMSkillExtractor({ llm, model });
    const draft = await extractor.extract(mkGroup());
    assert.strictEqual(draft.name, 'auto-planner-3001');
  });

  it('falls back when JSON is valid but the shape is missing fields', async () => {
    const llm = makeProvider(() => ({
      message: { role: 'assistant', content: '{"name":"x"}' },
      usage: { tokensIn: 0, tokensOut: 0 },
      durationMs: 0,
      finishReason: 'end_turn',
    }));
    const extractor = new LLMSkillExtractor({ llm, model });
    const draft = await extractor.extract(mkGroup());
    assert.strictEqual(draft.name, 'auto-planner-3001');
  });
});

describe('validateExtractedDraft', () => {
  it('rejects missing required fields', () => {
    assert.strictEqual(validateExtractedDraft(null).ok, false);
    assert.strictEqual(validateExtractedDraft({ name: 'x' }).ok, false);
    assert.strictEqual(
      validateExtractedDraft({
        name: 'x',
        description: 'd',
        tags: [],
        priority: 50,
        mode: 'advisory',
        triggers: {},
        // body missing
      }).ok,
      false
    );
  });

  it('accepts a complete draft', () => {
    const res = validateExtractedDraft({
      name: 'x',
      description: 'd',
      tags: [],
      priority: 50,
      mode: 'advisory',
      triggers: { keywords: ['k'] },
      body: '# title',
    });
    assert.strictEqual(res.ok, true);
    assert.ok(res.draft);
  });
});
