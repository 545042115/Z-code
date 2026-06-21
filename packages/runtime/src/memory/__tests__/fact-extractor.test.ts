// @z-assistant/runtime — fact extractor tests

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { extractFacts, heuristicFactExtract } from '../fact-extractor';

describe('heuristicFactExtract', () => {
  it('extracts location from "我在上海"', () => {
    const facts = heuristicFactExtract('我住在上海，明天要去北京出差');
    assert.strictEqual(facts.length, 1);
    assert.strictEqual(facts[0].factType, 'location');
    assert.strictEqual(facts[0].value, '上海');
    assert.strictEqual(facts[0].entity, 'user');
    assert.ok(facts[0].confidence > 0.9);
  });

  it('extracts English location', () => {
    const facts = heuristicFactExtract('I live in Berlin');
    assert.strictEqual(facts[0].factType, 'location');
    assert.strictEqual(facts[0].value, 'Berlin');
  });

  it('extracts preference', () => {
    const facts = heuristicFactExtract('I prefer dark mode');
    assert.strictEqual(facts[0].factType, 'preference');
    assert.strictEqual(facts[0].value, 'dark mode');
  });

  it('extracts constraint/allergy', () => {
    const facts = heuristicFactExtract('I am allergic to peanuts');
    assert.strictEqual(facts[0].factType, 'constraint');
    assert.strictEqual(facts[0].value, 'peanuts');
  });

  it('extracts identity', () => {
    const facts = heuristicFactExtract('I am a backend engineer');
    assert.strictEqual(facts[0].factType, 'identity');
    assert.strictEqual(facts[0].value, 'backend engineer');
  });

  it('extracts goal', () => {
    const facts = heuristicFactExtract('I plan to learn Rust next month');
    assert.strictEqual(facts[0].factType, 'goal');
    assert.ok(facts[0].value.includes('learn Rust'));
  });

  it('returns empty for neutral questions', () => {
    const facts = heuristicFactExtract('What is the weather today?');
    assert.strictEqual(facts.length, 0);
  });
});

describe('extractFacts with LLM fallback', () => {
  it('returns heuristic facts without calling LLM when rules match', async () => {
    let called = false;
    const facts = await extractFacts('我在上海', {
      llmExtractor: {
        extract: async () => { called = true; return []; },
      },
    });
    assert.strictEqual(facts.length, 1);
    assert.strictEqual(facts[0].factType, 'location');
    assert.strictEqual(called, false);
  });

  it('calls LLM when no heuristic matches', async () => {
    const facts = await extractFacts('The user mentioned offhand that they grew up in Kyoto', {
      llmExtractor: {
        extract: async () => [{
          factType: 'location',
          value: 'Kyoto',
          statement: 'grew up in Kyoto',
          confidence: 0.8,
          source: 'llm',
          entity: 'user',
        }],
      },
    });
    assert.strictEqual(facts.length, 1);
    assert.strictEqual(facts[0].value, 'Kyoto');
    assert.strictEqual(facts[0].source, 'llm');
  });

  it('filters low-confidence facts', async () => {
    const facts = await extractFacts('something vague', {
      minConfidence: 0.8,
      llmExtractor: {
        extract: async () => [{
          factType: 'preference',
          value: 'maybe blue',
          statement: 'maybe blue',
          confidence: 0.3,
          source: 'llm',
          entity: 'user',
        }],
      },
    });
    assert.strictEqual(facts.length, 0);
  });
});
