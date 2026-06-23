// @z-assistant/runtime — LLM-backed Success Skill Extractor (F-1).
//
// Asks an LLM to read a group of winding-but-successful conversations
// and produce a reusable workflow skill plus durable user facts.

import type {
  CandidateSkillDraft,
  ILLMProvider,
  ISuccessSkillExtractor,
  ModelSpec,
  SuccessExtractionResult,
  SuccessGroup,
} from '@z-assistant/contracts';

export interface LlmSuccessExtractorOptions {
  llmProvider: ILLMProvider;
  model: ModelSpec;
  temperature?: number;
  maxTokens?: number;
}

interface ExtractedShape {
  name?: string;
  description?: string;
  tags?: string[];
  priority?: number;
  mode?: 'advisory' | 'strict';
  triggers?: {
    keywords?: string[];
    intents?: string[];
    fileGlobs?: string[];
  };
  facts?: Array<{ type?: string; value?: string }>;
  body?: string;
}

const SKILL_EXTRACTION_PROMPT = `You are a skill author for an AI assistant. Given one or more conversations where the user had to correct the assistant before the assistant finally succeeded, extract a reusable workflow skill.

Respond with a SINGLE JSON object matching this shape:

{
  "name": "kebab-case-skill-name",
  "description": "one-sentence summary",
  "tags": ["auto-discovered", "workflow"],
  "priority": 60,
  "mode": "advisory",
  "triggers": {
    "keywords": ["keyword1", "keyword2"]
  },
  "facts": [
    { "type": "location|preference|constraint|goal", "value": "fact text" }
  ],
  "body": "markdown with ## Purpose, ## Use When, ## Workflow, ## Do, ## Do Not sections"
}

Rules:
- "facts" should contain durable user facts mentioned across the conversations (e.g. location, preferences, constraints).
- "body" should describe the correct workflow the assistant should follow next time it sees a similar request.
- Keep the body concise but specific.
- Do NOT wrap the JSON in markdown fences.`;

export class LlmSuccessSkillExtractor implements ISuccessSkillExtractor {
  private readonly llmProvider: ILLMProvider;
  private readonly model: ModelSpec;
  private readonly temperature: number;
  private readonly maxTokens: number;

  constructor(opts: LlmSuccessExtractorOptions) {
    this.llmProvider = opts.llmProvider;
    this.model = opts.model;
    this.temperature = opts.temperature ?? 0.3;
    this.maxTokens = opts.maxTokens ?? 2048;
  }

  async extract(group: SuccessGroup): Promise<SuccessExtractionResult> {
    const conversation = group.cases
      .map((c, idx) => `--- Conversation ${idx + 1} (${c.task}) ---\n${c.conversationMarkdown}`)
      .join('\n\n');

    const response = await this.llmProvider.generate({
      model: this.model,
      messages: [
        { role: 'system', content: SKILL_EXTRACTION_PROMPT },
        {
          role: 'user',
          content: `Task pattern: ${group.taskPattern}\n\n${conversation}`,
        },
      ],
      jsonMode: true,
      temperature: this.temperature,
      maxTokens: this.maxTokens,
    });

    const text = response.message.content ?? '';
    const parsed = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/gi, '')) as ExtractedShape;

    const draft: CandidateSkillDraft = {
      name: normalizeName(parsed.name || group.taskPattern),
      description: parsed.description || `Auto-discovered skill from winding success: ${group.taskPattern}`,
      tags: parsed.tags?.length ? parsed.tags : ['auto-discovered', 'success-driven'],
      priority: typeof parsed.priority === 'number' ? parsed.priority : 60,
      mode: parsed.mode === 'strict' ? 'strict' : 'advisory',
      triggers: {
        keywords: parsed.triggers?.keywords ?? [],
        intents: parsed.triggers?.intents ?? [],
        fileGlobs: parsed.triggers?.fileGlobs ?? [],
      },
      verification: {},
      body: parsed.body || '',
    };

    const facts = (parsed.facts ?? [])
      .filter((f) => typeof f.value === 'string' && f.value.length > 1)
      .map((f) => ({ type: f.type || 'unknown', value: f.value as string }));

    return { draft, facts };
  }
}

function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 64);
}
