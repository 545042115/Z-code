// @ziner/runtime — Auto-Discovery Orchestrator (P1-3 / F-1).
//
// Wires together failure/success case stores, skill extractors and the
// review queue to drive a single discovery sweep:
//
//   1. List cases within the configured window.
//   2. Group them.
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
  ISuccessCaseStore,
  ISuccessSkillExtractor,
  SuccessGroup,
} from '@ziner/contracts';
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
  /** Optional success case store (F-1). */
  successStore?: ISuccessCaseStore;
  /** Optional success skill extractor (F-1). */
  successExtractor?: ISuccessSkillExtractor;
}

const DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const DEFAULT_MIN_OCCURRENCES = 2;
const DEFAULT_MIN_CONFIDENCE = 0.6;
const DEFAULT_SUCCESS_MIN_TURNS = 4;
const DEFAULT_SUCCESS_MIN_CORRECTIONS = 1;

// ── AutoDiscoveryEngine ──────────────────────────────────────────────

export class AutoDiscoveryEngine {
  private readonly failureStore: IFailureCaseStore;
  private readonly extractor: ISkillExtractor;
  private readonly reviewQueue: ISkillReviewQueue;
  private readonly validator: (draft: CandidateSkillDraft) => CandidateValidation;
  private readonly defaults: AutoDiscoveryConfig;
  private readonly successStore?: ISuccessCaseStore;
  private readonly successExtractor?: ISuccessSkillExtractor;

  constructor(opts: AutoDiscoveryEngineOptions) {
    this.failureStore = opts.failureStore;
    this.extractor = opts.extractor;
    this.reviewQueue = opts.reviewQueue;
    this.validator = opts.validator ?? validateCandidate;
    this.defaults = opts.defaults ?? {};
    this.successStore = opts.successStore;
    this.successExtractor = opts.successExtractor;
  }

  /** Run a single discovery sweep. */
  async discover(cfg: AutoDiscoveryConfig = {}): Promise<AutoDiscoveryReport> {
    const source = cfg.source ?? this.defaults.source ?? 'failure';
    const scanFailure = source === 'failure' || source === 'all';
    const scanSuccess = source === 'success' || source === 'all';

    const proposed: CandidateSkill[] = [];
    const skipped: AutoDiscoveryReport['skipped'] = [];
    const discoveredFacts: Array<{ type: string; value: string }> = [];

    let scannedCases = 0;
    let scannedGroups = 0;
    let scannedSuccessCases: number | undefined;
    let scannedSuccessGroups: number | undefined;

    if (scanFailure) {
      const failureResult = await this.discoverFailures(cfg);
      scannedCases += failureResult.scannedCases;
      scannedGroups += failureResult.scannedGroups;
      proposed.push(...failureResult.proposed);
      skipped.push(...failureResult.skipped);
    }

    if (scanSuccess) {
      if (!this.successStore || !this.successExtractor) {
        skipped.push({ groupKey: 'success:config', reason: 'successStore or successExtractor not configured' });
      } else {
        const successResult = await this.discoverSuccesses(cfg);
        scannedSuccessCases = successResult.scannedCases;
        scannedSuccessGroups = successResult.scannedGroups;
        proposed.push(...successResult.proposed);
        skipped.push(...successResult.skipped);
        discoveredFacts.push(...successResult.facts);
      }
    }

    return {
      generatedAt: Date.now(),
      scannedCases,
      scannedGroups,
      scannedSuccessCases,
      scannedSuccessGroups,
      discoveredFacts: discoveredFacts.length > 0 ? discoveredFacts : undefined,
      proposedCandidates: proposed,
      skipped,
    };
  }

  private async discoverFailures(cfg: AutoDiscoveryConfig) {
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

    const eligible = groups.filter((g) => g.cases.length >= minOccurrences);
    for (const group of groups) {
      if (group.cases.length < minOccurrences) {
        skipped.push({ groupKey: group.key, reason: `below minOccurrences (${group.cases.length} < ${minOccurrences})` });
      }
    }

    // Extract candidate drafts in parallel; validation/enqueue remains serial
    // because the review queue may not support concurrent writes.
    const extractionResults = await Promise.allSettled(
      eligible.map(async (group) => {
        const candidate = await extractToCandidate(group, this.extractor, { confidence: minConfidence });
        return { group, candidate };
      }),
    );

    for (const res of extractionResults) {
      if (res.status === 'rejected') {
        skipped.push({ groupKey: 'unknown', reason: `extractor error: ${(res.reason as Error).message}` });
        continue;
      }
      const { group, candidate } = res.value;
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

    return { scannedCases: cases.length, scannedGroups: groups.length, proposed, skipped };
  }

  private async discoverSuccesses(cfg: AutoDiscoveryConfig) {
    const windowMs = cfg.windowMs ?? this.defaults.windowMs ?? DEFAULT_WINDOW_MS;
    const minConfidence =
      cfg.minConfidence ?? this.defaults.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
    const minTurns =
      cfg.successMinTurns ?? this.defaults.successMinTurns ?? DEFAULT_SUCCESS_MIN_TURNS;
    const minCorrections =
      cfg.successMinCorrections ?? this.defaults.successMinCorrections ?? DEFAULT_SUCCESS_MIN_CORRECTIONS;

    const now = Date.now();
    const fromTs = now - windowMs;

    const cases = await this.successStore!.list({ fromTs, toTs: now });
    const groups = await this.successStore!.group({ fromTs, toTs: now });

    const proposed: CandidateSkill[] = [];
    const skipped: AutoDiscoveryReport['skipped'] = [];
    const facts: Array<{ type: string; value: string }> = [];

    const eligible: SuccessGroup[] = [];
    for (const group of groups) {
      const windingCases = group.cases.filter(
        (c) => c.turnCount >= minTurns && c.correctionCount >= minCorrections,
      );
      if (windingCases.length === 0) {
        skipped.push({ groupKey: group.key, reason: `no winding successes (turns>=${minTurns}, corrections>=${minCorrections})` });
      } else {
        eligible.push({ ...group, cases: windingCases });
      }
    }

    const extractionResults = await Promise.allSettled(
      eligible.map(async (groupToExtract) => {
        const result = await this.successExtractor!.extract(groupToExtract);
        return { group: groupToExtract, result };
      }),
    );

    for (const res of extractionResults) {
      if (res.status === 'rejected') {
        skipped.push({ groupKey: 'unknown', reason: `success extractor error: ${(res.reason as Error).message}` });
        continue;
      }
      const { group, result } = res.value;
      const candidate = this.successResultToCandidate(result.draft, group, minConfidence);
      const validation = this.validator(candidate.draft);
      candidate.validation = validation;
      if (!validation.valid) {
        const reason = validation.issues.find((i) => i.severity === 'error')?.message ?? 'invalid draft';
        skipped.push({ groupKey: group.key, reason });
        continue;
      }
      await this.reviewQueue.enqueue(candidate);
      proposed.push(candidate);
      facts.push(...(result.facts ?? []));
    }

    return { scannedCases: cases.length, scannedGroups: groups.length, proposed, skipped, facts };
  }

  private successResultToCandidate(
    draft: CandidateSkillDraft,
    group: SuccessGroup,
    confidence: number,
  ): CandidateSkill {
    const now = Date.now();
    return {
      id: `${now}-${Math.random().toString(36).slice(2, 9)}`,
      proposedAt: now,
      sourceGroupKey: group.key,
      sourceCaseIds: group.cases.map((c) => c.id),
      confidence,
      status: 'pending',
      draft,
    };
  }
}
