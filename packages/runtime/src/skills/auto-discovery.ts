// @z-assistant/runtime — Auto-Discovery Orchestrator (P1-3).
//
// Wires together the failure case store, skill extractor and review
// queue to drive a single discovery sweep:
//
//   1. List failure cases within the configured window.
//   2. Group them by (agent, errorCode, errorPattern).
//   3. For each group with enough occurrences, ask the extractor to
//      draft a CandidateSkill.
//   4. Validate the draft. If invalid, mark the group skipped.
//   5. Enqueue the candidate for human review.
//   6. Return a structured AutoDiscoveryReport for observability.

import type {
  AutoDiscoveryConfig,
  AutoDiscoveryReport,
  CandidateSkill,
  CandidateSkillDraft,
  CandidateValidation,
  IFailureCaseStore,
  ISkillExtractor,
  ISkillReviewQueue,
} from '@z-assistant/contracts';
import { extractToCandidate } from './llm-extract';
import { validateCandidate } from './validator';

// ── Options ──────────────────────────────────────────────────────────

export interface AutoDiscoveryEngineOptions {
  failureStore: IFailureCaseStore;
  extractor: ISkillExtractor;
  reviewQueue: ISkillReviewQueue;
  /** Optional override of the default validator. */
  validator?: (draft: CandidateSkillDraft) => CandidateValidation;
  /** Default config merged with per-call config. */
  defaults?: AutoDiscoveryConfig;
}

const DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const DEFAULT_MIN_OCCURRENCES = 2;
const DEFAULT_MIN_CONFIDENCE = 0.6;

// ── AutoDiscoveryEngine ──────────────────────────────────────────────

export class AutoDiscoveryEngine {
  private readonly failureStore: IFailureCaseStore;
  private readonly extractor: ISkillExtractor;
  private readonly reviewQueue: ISkillReviewQueue;
  private readonly validator: (draft: CandidateSkillDraft) => CandidateValidation;
  private readonly defaults: AutoDiscoveryConfig;

  constructor(opts: AutoDiscoveryEngineOptions) {
    this.failureStore = opts.failureStore;
    this.extractor = opts.extractor;
    this.reviewQueue = opts.reviewQueue;
    this.validator = opts.validator ?? validateCandidate;
    this.defaults = opts.defaults ?? {};
  }

  /** Run a single discovery sweep. */
  async discover(cfg: AutoDiscoveryConfig = {}): Promise<AutoDiscoveryReport> {
    const windowMs = cfg.windowMs ?? this.defaults.windowMs ?? DEFAULT_WINDOW_MS;
    const minOccurrences =
      cfg.minOccurrences ?? this.defaults.minOccurrences ?? DEFAULT_MIN_OCCURRENCES;
    const minConfidence =
      cfg.minConfidence ?? this.defaults.minConfidence ?? DEFAULT_MIN_CONFIDENCE;

    const now = Date.now();
    const fromTs = now - windowMs;

    const cases = await this.failureStore.list({ fromTs, toTs: now });
    const groups = await this.failureStore.group({ fromTs, toTs: now });

    const proposed: CandidateSkill[] = [];
    const skipped: AutoDiscoveryReport['skipped'] = [];

    for (const group of groups) {
      if (group.cases.length < minOccurrences) {
        skipped.push({ groupKey: group.key, reason: `below minOccurrences (${group.cases.length} < ${minOccurrences})` });
        continue;
      }
      let candidate: CandidateSkill;
      try {
        candidate = await extractToCandidate(group, this.extractor, { confidence: minConfidence });
      } catch (err) {
        skipped.push({
          groupKey: group.key,
          reason: `extractor error: ${(err as Error).message}`,
        });
        continue;
      }
      const validation = this.validator(candidate.draft);
      candidate.validation = validation;
      if (!validation.valid) {
        const reason = validation.issues.find((i) => i.severity === 'error')?.message ?? 'invalid draft';
        skipped.push({ groupKey: group.key, reason });
        continue;
      }
      await this.reviewQueue.enqueue(candidate);
      proposed.push(candidate);
    }

    return {
      generatedAt: now,
      scannedCases: cases.length,
      scannedGroups: groups.length,
      proposedCandidates: proposed,
      skipped,
    };
  }
}
