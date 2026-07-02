// @ziner/runtime — Skill Extractors (P1-3 Skill Auto-Discovery).
//
// Two implementations of `ISkillExtractor`:
//
//   1. TemplateSkillExtractor — deterministic, LLM-free. Generates a
//      structured CandidateSkillDraft directly from a FailureGroup
//      using string templates. Used as the default fallback and in
//      tests.
//
//   2. LLMSkillExtractor — prompts an `ILLMProvider` to draft a
//      higher-quality skill. Returns to the template extractor when
//      the LLM fails or emits malformed JSON.
//
// The drafts are then promoted to `CandidateSkill` records by
// `extractToCandidate`, which fills in the orchestration metadata
// (id, proposedAt, sourceGroupKey, sourceCaseIds, confidence,
// status).

import { randomUUID } from 'node:crypto';
import type {
  CandidateSkill,
  CandidateSkillDraft,
  FailureGroup,
  ISkillExtractor,
  ILLMProvider,
  ModelSpec,
  LLMMessage,
} from '@ziner/contracts';

// ── Validation of an extracted draft ─────────────────────────────────

export interface DraftValidationResult {
  ok: boolean;
  draft?: CandidateSkillDraft;
  reason?: string;
}

/**
 * Best-effort shape check used by the LLM extractor's fallback path.
 * Does NOT enforce semantic invariants (see `validateCandidate` for
 * that); it only confirms the required fields exist and are typed
 * correctly enough to be safely consumed.
 */
export function validateExtractedDraft(draft: unknown): DraftValidationResult {
  if (!draft || typeof draft !== 'object') {
    return { ok: false, reason: 'draft is not an object' };
  }
  const d = draft as Record<string, unknown>;
  if (typeof d.name !== 'string' || !d.name) {
    return { ok: false, reason: 'name is required' };
  }
  if (typeof d.description !== 'string' || !d.description) {
    return { ok: false, reason: 'description is required' };
  }
  if (!Array.isArray(d.tags)) {
    return { ok: false, reason: 'tags must be an array' };
  }
  if (typeof d.priority !== 'number') {
    return { ok: false, reason: 'priority must be a number' };
  }
  if (d.mode !== 'advisory' && d.mode !== 'strict') {
    return { ok: false, reason: "mode must be 'advisory' or 'strict'" };
  }
  if (!d.triggers || typeof d.triggers !== 'object') {
    return { ok: false, reason: 'triggers is required' };
  }
  if (typeof d.body !== 'string' || !d.body) {
    return { ok: false, reason: 'body is required' };
  }
  return { ok: true, draft: d as unknown as CandidateSkillDraft };
}

// ── TemplateSkillExtractor ───────────────────────────────────────────

/**
 * Deterministic, LLM-free extractor. Useful as a default and as the
 * LLM extractor's fallback. Produces a syntactically-valid draft from
 * a FailureGroup without any external calls.
 */
export class TemplateSkillExtractor implements ISkillExtractor {
  async extract(group: FailureGroup): Promise<CandidateSkillDraft> {
    return templateDraft(group);
  }
}

function sanitizeName(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 64);
}

function templateDraft(group: FailureGroup): CandidateSkillDraft {
  const baseName = sanitizeName(`auto-${group.agent}-${group.errorCode}`);
  const keywords = deriveKeywords(group.errorPattern);
  const tags: string[] = ['auto-discovered', sanitizeName(group.agent), sanitizeName(group.errorCode)];
  for (const t of group.toolNames) {
    const sanitized = sanitizeName(t);
    if (sanitized && !tags.includes(sanitized)) tags.push(sanitized);
  }
  const description = `Auto-generated skill for recurring ${group.errorCode} failures in ${group.agent} (pattern: ${group.errorPattern.slice(0, 60)})`;
  const body = renderBody(group);
  return {
    name: baseName,
    description,
    tags,
    priority: 40,
    mode: 'advisory',
    triggers: {
      keywords,
      intents: [group.agent],
    },
    body,
  };
}

function deriveKeywords(pattern: string): string[] {
  const tokens = pattern
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/[^a-z0-9_<>-]/g, ''))
    .filter((t) => t.length > 2 && !t.startsWith('<'));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tokens) {
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= 5) break;
  }
  return out;
}

function renderBody(group: FailureGroup): string {
  const samples = group.cases.slice(0, 3);
  const sampleLines = samples
    .map((c, i) => `${i + 1}. \`${c.errorMessage.slice(0, 140)}\``)
    .join('\n');
  return [
    `# ${group.agent} — recurring ${group.errorCode}`,
    '',
    '## Purpose',
    `Mitigate recurring \`${group.errorCode}\` failures observed in the \`${group.agent}\` agent.`,
    `Normalized pattern: \`${group.errorPattern.slice(0, 120)}\`.`,
    '',
    '## Use When',
    `- The task is dispatched to \`${group.agent}\`.`,
    `- Inputs resemble cases that previously failed with \`${group.errorCode}\`.`,
    '',
    '## Workflow',
    '1. Inspect inputs against the normalized failure pattern before invoking tools.',
    '2. If preconditions cannot be verified, ask the user before continuing.',
    '3. Prefer the smallest possible change; verify after each step.',
    '',
    '## Do',
    `- Recognise the failure pattern: \`${group.errorPattern.slice(0, 120)}\`.`,
    '- Capture additional context (file, args) for future debugging.',
    '',
    '## Do Not',
    `- Retry the same call blindly; this error has recurred ${group.cases.length} time(s).`,
    '- Mask the underlying root cause with broad try/catch blocks.',
    '',
    '## Sample Cases',
    sampleLines || '_no samples available_',
  ].join('\n');
}

// ── LLMSkillExtractor ───────────────────────────────────────────────

export interface LLMSkillExtractorOptions {
  llm: ILLMProvider;
  model: ModelSpec;
  /** Fallback extractor if the LLM fails. Defaults to TemplateSkillExtractor. */
  fallback?: ISkillExtractor;
  /** Optional temperature override. */
  temperature?: number;
}

/**
 * LLM-backed extractor. Builds a prompt asking the model to return
 * a JSON object matching CandidateSkillDraft. Falls back to the
 * template extractor on any error.
 */
export class LLMSkillExtractor implements ISkillExtractor {
  private readonly llm: ILLMProvider;
  private readonly model: ModelSpec;
  private readonly fallback: ISkillExtractor;
  private readonly temperature: number;

  constructor(opts: LLMSkillExtractorOptions) {
    this.llm = opts.llm;
    this.model = opts.model;
    this.fallback = opts.fallback ?? new TemplateSkillExtractor();
    this.temperature = opts.temperature ?? 0.2;
  }

  async extract(group: FailureGroup): Promise<CandidateSkillDraft> {
    try {
      const messages: LLMMessage[] = [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserPrompt(group) },
      ];
      const res = await this.llm.generate({
        model: this.model,
        messages,
        jsonMode: true,
        temperature: this.temperature,
      });
      const text = res.message.content ?? '';
      const parsed = tryParseJson(text);
      const valid = validateExtractedDraft(parsed);
      if (!valid.ok || !valid.draft) {
        return this.fallback.extract(group);
      }
      return valid.draft;
    } catch {
      return this.fallback.extract(group);
    }
  }
}

const SYSTEM_PROMPT = `You are a skill author for an autonomous coding agent. Given a cluster of recurring failures, draft a markdown skill that helps the agent avoid them in the future.

Respond with a SINGLE JSON object matching this TypeScript shape:

{
  "name": string,                                  // kebab-case, 2..64 chars
  "description": string,                           // one-sentence summary
  "tags": string[],                                // include "auto-discovered"
  "priority": number,                              // 0..100, default 40
  "mode": "advisory" | "strict",
  "triggers": {
    "intents"?: string[],
    "fileGlobs"?: string[],
    "keywords"?: string[]
  },
  "body": string                                   // markdown with ##Purpose, ##Use When, ##Workflow, ##Do, ##Do Not sections
}

Do NOT wrap the JSON in markdown fences. Do NOT include commentary. Return only the JSON object.`;

function buildUserPrompt(group: FailureGroup): string {
  const sample = group.cases
    .slice(0, 5)
    .map((c, i) => `${i + 1}. [${c.errorCode}] ${c.errorMessage.slice(0, 200)}`)
    .join('\n');
  return [
    `Agent: ${group.agent}`,
    `Error code: ${group.errorCode}`,
    `Normalized pattern: ${group.errorPattern}`,
    `Tool names: ${group.toolNames.join(', ') || '(none)'}`,
    `Occurrences: ${group.cases.length}`,
    '',
    'Sample failures:',
    sample,
  ].join('\n');
}

function tryParseJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;
  // Strip code fences if present.
  const stripped = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();
  try {
    return JSON.parse(stripped);
  } catch {
    return null;
  }
}

// ── Promotion helper ────────────────────────────────────────────────

export interface ExtractToCandidateOptions {
  confidence?: number;
}

/**
 * Run an extractor over a FailureGroup and wrap the resulting draft
 * in a full CandidateSkill record (status='pending').
 */
export async function extractToCandidate(
  group: FailureGroup,
  extractor: ISkillExtractor,
  opts: ExtractToCandidateOptions = {}
): Promise<CandidateSkill> {
  const draft = await extractor.extract(group);
  return {
    id: randomUUID(),
    proposedAt: Date.now(),
    sourceGroupKey: group.key,
    sourceCaseIds: group.cases.map((c) => c.id),
    draft,
    confidence: opts.confidence ?? 0.6,
    status: 'pending',
  };
}
