// @ziner/runtime — Skill Validator (P1-3 Skill Auto-Discovery).
//
// Structural / semantic validation for CandidateSkillDraft records
// proposed by ISkillExtractor implementations. The runtime's existing
// `validateSkill` checks fully-parsed Skill records (post-loader);
// this complementary `validateCandidate` works on the lighter draft
// shape and surfaces issues before the candidate hits the review
// queue.

import type {
  CandidateSkillDraft,
  CandidateValidation,
} from '@ziner/contracts';

export { validateSkill } from './skills';

// ── validateCandidate ────────────────────────────────────────────────

const NAME_PATTERN = /^[a-z0-9_-]{2,64}$/i;
const HEADING_PATTERN = /^#{1,3}\s+/gm;
const MIN_BODY_LENGTH = 50;

/**
 * Validate a CandidateSkillDraft. Returns a structured
 * `CandidateValidation` with severity-tagged issues. An issue with
 * severity='error' makes the candidate invalid.
 */
export function validateCandidate(draft: CandidateSkillDraft): CandidateValidation {
  const issues: CandidateValidation['issues'] = [];

  // ── name ───────────────────────────────────────────────────────
  if (!draft.name || typeof draft.name !== 'string' || !draft.name.trim()) {
    issues.push({ severity: 'error', field: 'name', message: 'name is required' });
  } else if (!NAME_PATTERN.test(draft.name)) {
    issues.push({
      severity: 'error',
      field: 'name',
      message: 'name must match /^[a-z0-9_-]{2,64}$/i',
    });
  }

  // ── description ────────────────────────────────────────────────
  if (!draft.description || typeof draft.description !== 'string' || !draft.description.trim()) {
    issues.push({ severity: 'error', field: 'description', message: 'description is required' });
  }

  // ── tags ───────────────────────────────────────────────────────
  if (!Array.isArray(draft.tags)) {
    issues.push({ severity: 'error', field: 'tags', message: 'tags must be an array' });
  }

  // ── priority ───────────────────────────────────────────────────
  if (typeof draft.priority !== 'number' || draft.priority < 0 || draft.priority > 100) {
    issues.push({ severity: 'warning', field: 'priority', message: 'priority should be in [0, 100]' });
  }

  // ── mode ───────────────────────────────────────────────────────
  if (draft.mode !== 'advisory' && draft.mode !== 'strict') {
    issues.push({ severity: 'error', field: 'mode', message: "mode must be 'advisory' or 'strict'" });
  }

  // ── body ───────────────────────────────────────────────────────
  if (typeof draft.body !== 'string' || draft.body.length < MIN_BODY_LENGTH) {
    issues.push({
      severity: 'error',
      field: 'body',
      message: `body must be at least ${MIN_BODY_LENGTH} characters`,
    });
  } else {
    const headings = draft.body.match(HEADING_PATTERN) ?? [];
    if (headings.length < 2) {
      issues.push({
        severity: 'warning',
        field: 'body',
        message: 'body should contain at least two markdown headings',
      });
    }
  }

  // ── triggers ───────────────────────────────────────────────────
  const triggers = draft.triggers;
  const hasIntents = !!triggers?.intents && triggers.intents.length > 0;
  const hasKeywords = !!triggers?.keywords && triggers.keywords.length > 0;
  const hasGlobs = !!triggers?.fileGlobs && triggers.fileGlobs.length > 0;
  if (!triggers || (!hasIntents && !hasKeywords && !hasGlobs)) {
    issues.push({
      severity: 'error',
      field: 'triggers',
      message: 'triggers must include at least one of intents, keywords, fileGlobs',
    });
  }

  return {
    valid: !issues.some((i) => i.severity === 'error'),
    issues,
  };
}
