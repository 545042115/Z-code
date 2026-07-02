// @ziner/runtime — Skill Composition Engine (P1-3).
//
// Co-occurrence based macro-skill proposer. Given recent
// SelectedSkill traces (one array per session/turn), the engine
// looks for pairs of skills that consistently activate together
// and emits a SkillCompositionProposal whose draft body fuses the
// underlying skills' purpose / use-when sections.
//
// The implementation is deliberately simple — it does not attempt
// to deduplicate workflow steps or run an LLM polish pass; that
// can be layered on top later. The cooccurrence threshold is a
// classic Jaccard ratio over sessions.

import { randomUUID } from 'node:crypto';
import type {
  ISkillCompositionEngine,
  SelectedSkill,
  SkillCompositionProposal,
  CandidateSkillDraft,
} from '@ziner/contracts';

// ── CooccurrenceCompositionEngine ────────────────────────────────────

export interface CooccurrenceProposeInput {
  recentSelections: SelectedSkill[][];
  /** Default 0.5. */
  minCooccurrence?: number;
  /** Minimum sessions in which the pair both appear. Default 3. */
  minSessions?: number;
}

export class CooccurrenceCompositionEngine implements ISkillCompositionEngine {
  async propose(input: CooccurrenceProposeInput): Promise<SkillCompositionProposal[]> {
    const sessions = input.recentSelections ?? [];
    if (sessions.length === 0) return [];
    const minCo = input.minCooccurrence ?? 0.5;
    const minSessions = input.minSessions ?? 3;

    // Index skills by id and count appearances + pair co-occurrence.
    const skillById = new Map<string, SelectedSkill>();
    const presence = new Map<string, Set<number>>(); // skillId -> set of session indexes

    sessions.forEach((sel, idx) => {
      const seenInSession = new Set<string>();
      for (const s of sel) {
        if (!s.skill) continue;
        const id = s.skill.id;
        if (seenInSession.has(id)) continue;
        seenInSession.add(id);
        if (!skillById.has(id)) skillById.set(id, s);
        let set = presence.get(id);
        if (!set) {
          set = new Set();
          presence.set(id, set);
        }
        set.add(idx);
      }
    });

    const ids = [...presence.keys()];
    const out: SkillCompositionProposal[] = [];
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = ids[i];
        const b = ids[j];
        const setA = presence.get(a)!;
        const setB = presence.get(b)!;
        let both = 0;
        for (const s of setA) if (setB.has(s)) both++;
        if (both < minSessions) continue;
        const either = setA.size + setB.size - both;
        if (either === 0) continue;
        const ratio = both / either;
        if (ratio < minCo) continue;

        const aSel = skillById.get(a)!;
        const bSel = skillById.get(b)!;
        out.push({
          id: randomUUID(),
          partIds: [a, b],
          draft: composeDraft(aSel, bSel),
          cooccurrence: ratio,
          score: ratio * both,
        });
      }
    }
    out.sort((p, q) => q.score - p.score);
    return out;
  }
}

function composeDraft(a: SelectedSkill, b: SelectedSkill): CandidateSkillDraft {
  const aSkill = a.skill;
  const bSkill = b.skill;
  const aTriggers = aSkill.triggers ?? {};
  const bTriggers = bSkill.triggers ?? {};
  const aBody = readBody(aSkill);
  const bBody = readBody(bSkill);
  const name = sanitizeName(`compose-${aSkill.name}-${bSkill.name}`);
  const tags = unique([
    'auto-discovered',
    'composed',
    ...(aSkill.tags ?? []),
    ...(bSkill.tags ?? []),
  ]);
  const keywords = unique([
    ...(aTriggers.keywords ?? []),
    ...(bTriggers.keywords ?? []),
  ]);
  const intents = unique([
    ...(aTriggers.intents ?? []),
    ...(bTriggers.intents ?? []),
  ]);
  const body = [
    `# Macro-skill: ${aSkill.name} + ${bSkill.name}`,
    '',
    '## Purpose',
    `Combine ${aSkill.name} and ${bSkill.name} when both routinely apply to the same task.`,
    '',
    `## From ${aSkill.name}`,
    aBody.slice(0, 400),
    '',
    `## From ${bSkill.name}`,
    bBody.slice(0, 400),
    '',
    '## Workflow',
    `1. Apply guidance from \`${aSkill.name}\` first.`,
    `2. Then enforce constraints from \`${bSkill.name}\`.`,
    '3. Verify the result satisfies both before completion.',
  ].join('\n');
  return {
    name,
    description: `Macro-skill combining ${aSkill.name} and ${bSkill.name}.`,
    tags,
    priority: 45,
    mode: 'advisory',
    triggers: { intents, keywords },
    body,
  };
}

/** Read a body-like string from either contracts' SkillSpec (`body`)
 *  or the runtime's parsed Skill (`content`). */
function readBody(skill: SelectedSkill['skill']): string {
  const candidate = (skill as { body?: unknown; content?: unknown }).body
    ?? (skill as { body?: unknown; content?: unknown }).content;
  return typeof candidate === 'string' ? candidate : '';
}

function sanitizeName(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 64);
}

function unique<T>(arr: T[]): T[] {
  const seen = new Set<T>();
  const out: T[] = [];
  for (const x of arr) {
    if (seen.has(x)) continue;
    seen.add(x);
    out.push(x);
  }
  return out;
}
