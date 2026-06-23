// Success-Driven Skill Discovery for the Desktop Chat Agent.
//
// Scans History/*.md files for conversations that required multiple
// corrections before reaching a successful outcome, then asks an LLM to
// extract:
//   1. durable user facts (location, preferences, constraints)
//   2. a workflow skill that would avoid the same detour next time
//
// Candidates are enqueued in JsonFileSkillReviewQueue for human approval.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  CandidateSkill,
  ILLMProvider,
  ModelSpec,
} from '@z-assistant/contracts';
import type {
  JsonFileSkillReviewQueue,
} from '@z-assistant/runtime/skills';

export interface SuccessSkillDiscoveryOptions {
  /** Directory containing conversation history markdown files. */
  historyDir: string;
  /** LLM provider used to summarize conversations into skill drafts. */
  llmProvider: ILLMProvider;
  /** Model to use for extraction. */
  model: ModelSpec;
  /** Review queue to enqueue generated candidates. */
  reviewQueue: JsonFileSkillReviewQueue;
  /** Minimum number of user/assistant turns to consider. Default 4. */
  minTurns?: number;
  /** Temperature for extraction. Default 0.3. */
  temperature?: number;
}

interface ParsedConversation {
  filePath: string;
  title: string;
  turns: { role: 'user' | 'assistant'; content: string; timestamp?: string }[];
}

const CORRECTION_MARKERS = [
  '不对', '错了', '没有', '不是', '你没有', '你没有根据', '你没有按',
  '重新', '再查', '不对，', 'no,', 'not quite', 'that is wrong',
  '你没有理解', '你没理解', '你没按', '你没根据',
];

const SUCCESS_MARKERS = [
  '结果', '路线', '方案', '建议', '总结', '如下', '完成了', '搞定了',
];

function parseHistoryFile(filePath: string): ParsedConversation | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const lines = raw.split('\n');
    const title = lines[0]?.replace(/^#\s*/, '').trim() || path.basename(filePath);
    const turns: ParsedConversation['turns'] = [];

    let currentRole: 'user' | 'assistant' | null = null;
    let currentContent: string[] = [];
    let currentTimestamp: string | undefined;

    const flush = () => {
      if (currentRole && currentContent.length > 0) {
        turns.push({
          role: currentRole,
          content: currentContent.join('\n').trim(),
          timestamp: currentTimestamp,
        });
      }
      currentRole = null;
      currentContent = [];
      currentTimestamp = undefined;
    };

    for (const line of lines) {
      const userMatch = line.match(/^\*\*You\*\*\s*\(([^)]*)\):\s*$/);
      const assistantMatch = line.match(/^\*\*Assistant\*\*\s*\(([^)]*)\):\s*$/);
      if (userMatch) {
        flush();
        currentRole = 'user';
        currentTimestamp = userMatch[1];
      } else if (assistantMatch) {
        flush();
        currentRole = 'assistant';
        currentTimestamp = assistantMatch[1];
      } else if (line.startsWith('---')) {
        // skip separators
      } else if (currentRole) {
        currentContent.push(line);
      }
    }
    flush();
    return { filePath, title, turns };
  } catch (err) {
    console.warn(`[SuccessSkillDiscovery] Failed to parse ${filePath}:`, err);
    return null;
  }
}

function looksLikeCorrection(turns: ParsedConversation['turns']): boolean {
  return turns.some((t) =>
    t.role === 'user' &&
    CORRECTION_MARKERS.some((m) => t.content.toLowerCase().includes(m.toLowerCase()))
  );
}

function looksLikeSuccess(turns: ParsedConversation['turns']): boolean {
  const lastAssistant = [...turns].reverse().find((t) => t.role === 'assistant');
  if (!lastAssistant) return false;
  return SUCCESS_MARKERS.some((m) => lastAssistant.content.includes(m));
}

function isWindingSuccess(conv: ParsedConversation, minTurns: number): boolean {
  return (
    conv.turns.length >= minTurns &&
    looksLikeCorrection(conv.turns) &&
    looksLikeSuccess(conv.turns)
  );
}

function formatConversation(conv: ParsedConversation): string {
  return conv.turns
    .map((t) => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.content}`)
    .join('\n\n');
}

const SKILL_EXTRACTION_PROMPT = `You are a skill author for an AI assistant. Given a conversation where the user had to correct the assistant before the assistant finally succeeded, extract a reusable workflow skill.

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
- "facts" should contain durable user facts mentioned in the conversation (e.g. location, preferences).
- "body" should describe the correct workflow the assistant should follow next time it sees a similar request.
- Keep the body concise but specific.
- Do NOT wrap the JSON in markdown fences.`;

interface ExtractedSkill {
  name?: string;
  description?: string;
  tags?: string[];
  priority?: number;
  mode?: 'advisory' | 'strict';
  triggers?: { keywords?: string[]; intents?: string[]; fileGlobs?: string[] };
  facts?: Array<{ type: string; value: string }>;
  body?: string;
}

function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 64);
}

export async function discoverSuccessSkills(
  opts: SuccessSkillDiscoveryOptions,
): Promise<{ candidates: CandidateSkill[]; facts: Array<{ type: string; value: string }> }> {
  const {
    historyDir,
    llmProvider,
    model,
    reviewQueue,
    minTurns = 4,
    temperature = 0.3,
  } = opts;

  const candidates: CandidateSkill[] = [];
  const allFacts: Array<{ type: string; value: string }> = [];

  if (!fs.existsSync(historyDir)) {
    return { candidates, facts: allFacts };
  }

  const files = fs.readdirSync(historyDir).filter((f) => f.endsWith('.md'));

  for (const file of files) {
    const filePath = path.join(historyDir, file);
    const conv = parseHistoryFile(filePath);
    if (!conv || !isWindingSuccess(conv, minTurns)) continue;

    try {
      const res = await llmProvider.generate({
        model,
        messages: [
          { role: 'system', content: SKILL_EXTRACTION_PROMPT },
          {
            role: 'user',
            content: `Conversation title: ${conv.title}\n\n${formatConversation(conv)}`,
          },
        ],
        jsonMode: true,
        temperature,
        maxTokens: 2048,
      });

      const text = res.message.content ?? '';
      const parsed = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/gi, '')) as ExtractedSkill;

      if (!parsed.name || !parsed.body) continue;

      const now = Date.now();
      const candidate: CandidateSkill = {
        id: randomUUID(),
        proposedAt: now,
        sourceGroupKey: `success:${path.basename(filePath)}`,
        sourceCaseIds: [],
        confidence: 0.75,
        status: 'pending',
        draft: {
          name: normalizeName(parsed.name),
          description: parsed.description || `Auto-discovered skill from ${conv.title}`,
          tags: parsed.tags?.length ? parsed.tags : ['auto-discovered', 'success-driven'],
          priority: typeof parsed.priority === 'number' ? parsed.priority : 60,
          mode: parsed.mode === 'strict' ? 'strict' : 'advisory',
          triggers: {
            keywords: parsed.triggers?.keywords ?? [],
            intents: parsed.triggers?.intents ?? [],
            fileGlobs: parsed.triggers?.fileGlobs ?? [],
          },
          verification: {},
          body: parsed.body,
        },
      };

      await reviewQueue.enqueue(candidate);
      candidates.push(candidate);

      if (parsed.facts) {
        for (const f of parsed.facts) {
          if (f.value && f.value.length > 1) {
            allFacts.push({ type: f.type || 'unknown', value: f.value });
          }
        }
      }
    } catch (err) {
      console.warn(`[SuccessSkillDiscovery] Failed to extract skill from ${filePath}:`, err);
    }
  }

  return { candidates, facts: allFacts };
}
