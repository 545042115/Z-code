// @z-assistant/runtime — User Fact Extractor
//
// Extracts durable facts about the user from a single message.
// Two-stage approach:
//   1. Fast heuristic rules for common patterns (location, identity, constraints).
//   2. Lightweight LLM extraction for everything else.
//
// Extracted facts are stored as long-term memory so the agent can recall them
// in future conversations.

export type FactType =
  | 'location'
  | 'preference'
  | 'constraint'
  | 'identity'
  | 'goal'
  | 'relationship'
  | 'none';

export interface ExtractedFact {
  factType: FactType;
  /** Entity the fact is about, e.g. "user", "team", "project". */
  entity?: string;
  /** Normalised value, e.g. "Shanghai" or "dislikes spicy food". */
  value: string;
  /** Original statement from the user. */
  statement: string;
  /** Extraction confidence in [0, 1]. */
  confidence: number;
  /** Which extractor produced the fact. */
  source: 'heuristic' | 'llm';
}

export interface FactExtractorOptions {
  /** Optional LLM extractor. If not provided, only heuristics are used. */
  llmExtractor?: LLMFactExtractor;
  /** Minimum confidence to keep a fact. */
  minConfidence?: number;
}

export interface LLMFactExtractor {
  extract(message: string): Promise<ExtractedFact[]>;
}

interface HeuristicRule {
  factType: FactType;
  /** Capturing group 1 must be the fact value. */
  regex: RegExp;
  /** Default entity when not captured. */
  entity?: string;
  confidence: number;
}

const HEURISTIC_RULES: HeuristicRule[] = [
  // Location / geography
  {
    factType: 'location',
    regex: /(?:我住在|我居住在|我在|我位于)\s*([^，。.,!?！？\n]{1,40})|(?:I live in|I am in|I'm in|I am located in)\b\s*([^，。.,!?！？\n]{1,40})/gi,
    entity: 'user',
    confidence: 0.92,
  },
  {
    factType: 'location',
    regex: /(?:我的位置是|我的坐标是)\s*([^，。.,!?！？\n]{1,40})|(?:my location is|my city is)\b\s*([^，。.,!?！？\n]{1,40})/gi,
    entity: 'user',
    confidence: 0.95,
  },
  // Identity / role
  {
    factType: 'identity',
    regex: /(?:我是|我从事|我的工作)\s*([^，。.,!?！？\n]{1,60})|(?:I am a|I am an|I work as|my role is)\b\s*([^，。.,!?！？\n]{1,60})/gi,
    entity: 'user',
    confidence: 0.88,
  },
  // Preferences (positive)
  {
    factType: 'preference',
    regex: /(?:我喜欢|我爱|我偏好)\s*([^，。.,!?！？\n]{1,80})|(?:I like|I love|I prefer|I enjoy)\b\s*([^，。.,!?！？\n]{1,80})/gi,
    entity: 'user',
    confidence: 0.85,
  },
  // Preferences (negative)
  {
    factType: 'preference',
    regex: /(?:我不喜欢|我讨厌|我厌恶)\s*([^，。.,!?！？\n]{1,80})|(?:I dislike|I hate|I do not like)\b\s*([^，。.,!?！？\n]{1,80})/gi,
    entity: 'user',
    confidence: 0.85,
  },
  // Constraints / allergies / cannot
  {
    factType: 'constraint',
    regex: /(?:我不能|我不可以|我过敏|我忌口)\s*([^，。.,!?！？\n]{1,80})|(?:I cannot|I can't|I'm allergic to|I am allergic to)\b\s*([^，。.,!?！？\n]{1,80})/gi,
    entity: 'user',
    confidence: 0.9,
  },
  // Goals / plans
  {
    factType: 'goal',
    regex: /(?:我要|我想|我计划|我准备)\s*([^，。.,!?！？\n]{1,100})|(?:I want to|I plan to|I need to|I intend to)\b\s*([^，。.,!?！？\n]{1,100})/gi,
    entity: 'user',
    confidence: 0.75,
  },
  // Relationship
  {
    factType: 'relationship',
    regex: /(?:我的.*是)\s*([^，。.,!?！？\n]{1,60})|(?:my\s+\w+\s+is)\b\s*([^，。.,!?！？\n]{1,60})/gi,
    entity: 'user',
    confidence: 0.7,
  },
];

/**
 * Extract facts from a user message using fast heuristic rules.
 * Returns an empty array if nothing matches.
 */
export function heuristicFactExtract(message: string): ExtractedFact[] {
  const facts: ExtractedFact[] = [];
  for (const rule of HEURISTIC_RULES) {
    const matches = message.matchAll(rule.regex);
    for (const m of matches) {
      const value = (m[1] ?? m[2])?.trim();
      if (!value || value.length < 2) continue;
      facts.push({
        factType: rule.factType,
        entity: rule.entity ?? 'user',
        value: normaliseValue(rule.factType, value),
        statement: m[0]?.trim() ?? value,
        confidence: rule.confidence,
        source: 'heuristic',
      });
    }
  }
  return facts;
}

function normaliseValue(type: FactType, value: string): string {
  const v = value.trim();
  switch (type) {
    case 'location':
      // Strip trailing "的" / "那边" etc.
      return v.replace(/[那边附近里]$/u, '');
    case 'preference':
      if (/^(?:我?不喜欢|I dislike|I hate|I do not like)/i.test(v)) return v;
      return v;
    default:
      return v;
  }
}

/**
 * Extract facts using rules first, then optionally fall back to an LLM.
 *
 * Heuristic hits are returned immediately (cheap). If no heuristic matches and
 * an LLM extractor is supplied, the LLM is asked once.
 */
export async function extractFacts(
  message: string,
  opts: FactExtractorOptions = {},
): Promise<ExtractedFact[]> {
  const minConfidence = opts.minConfidence ?? 0.6;

  const heuristic = heuristicFactExtract(message).filter((f) => f.confidence >= minConfidence);
  if (heuristic.length > 0) return heuristic;

  if (!opts.llmExtractor) return [];

  const llmFacts = await opts.llmExtractor.extract(message);
  return llmFacts.filter((f) => f.confidence >= minConfidence && f.factType !== 'none');
}
