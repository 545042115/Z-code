// Skill Auto-Discovery Contracts — P1-3.
//
// Defines the cross-package types for the Skill Auto-Discovery
// subsystem. The flow is:
//
//   1. Agent fails → Evolution clusters fingerprints (existing).
//   2. FailureCaseStore records each failure with full context.
//   3. SkillExtractor (LLM-backed) proposes a CandidateSkill from a
//      cluster of recurring failures.
//   4. SkillValidator runs syntactic + structural checks.
//   5. SkillReviewQueue holds candidates pending human approval.
//   6. SkillVersionRegistry tracks v1 / v2 / rollback per skill id.
//   7. SkillObsolescenceDetector flags skills whose verification
//      commands now fail (or whose success rate drops below a
//      threshold).
//   8. SkillCompositionEngine combines accepted micro-skills into
//      higher-level macro-skills.
//   9. SkillIndexer maintains a fast lookup index over the active
//      skill set.
//  10. SkillCommunity (opt-in) shares accepted skills across users.

import type { SelectedSkill } from './skill';

/**
 * Structural Skill record used by the auto-discovery contracts.
 * Mirrors `@ziner/runtime`'s parsed Skill shape so the
 * contracts can describe indexer and community store operations
 * without depending on the runtime. Concrete implementations may
 * provide additional fields.
 */
export interface Skill {
  id: string;
  name: string;
  description?: string;
  tags: string[];
  priority: number;
  mode: 'advisory' | 'strict';
  triggers: {
    intents?: string[];
    fileGlobs?: string[];
    keywords?: string[];
  };
  stopIf?: string[];
  imports?: string[];
  toolsAllow?: string[];
  verification?: {
    commands?: string[];
    notes?: string[];
  };
  /** Markdown body (also referenced as `content` in some runtimes). */
  content: string;
  /** Optional parsed sections (Purpose / Use When / etc.). */
  sections?: Record<string, string | undefined>;
  path?: string;
  rootDir?: string;
}

// ── Failure Case ─────────────────────────────────────────────────────

/**
 * A recorded failure case. Captured when an agent run ends with
 * status='failed' (or any verifier failure). Carries enough context
 * to reproduce, cluster, and extract.
 */
export interface FailureCase {
  /** Stable id. */
  id: string;
  /** When recorded. */
  timestamp: number;
  /** Associated AgentRun id. */
  runId: string;
  /** Agent that owned the failing span. */
  agent: string;
  /** Task summary (first 200 chars of run.task). */
  task: string;
  /** Failure summary. */
  errorCode: string;
  errorMessage: string;
  /** Normalized pattern (digits/paths replaced). */
  errorPattern: string;
  /** Optional: which tool call failed. */
  toolName?: string;
  /** Optional: arguments to the failing tool. */
  toolArgs?: Record<string, unknown>;
  /** Optional: model output before failure. */
  modelOutput?: string;
  /** Optional: span tree summary (top-k nodes). */
  spanSummary?: string;
  /** Optional: tags supplied by the verifier. */
  tags?: string[];
}

/** Filter for querying FailureCaseStore. */
export interface FailureCaseQuery {
  agent?: string;
  errorCode?: string;
  errorPattern?: string;
  toolName?: string;
  fromTs?: number;
  toTs?: number;
  limit?: number;
}

/** Persisted store for failure cases. */
export interface IFailureCaseStore {
  record(fc: FailureCase): Promise<void>;
  list(q?: FailureCaseQuery): Promise<FailureCase[]>;
  /** Count cases that match the predicate. */
  count(q?: FailureCaseQuery): Promise<number>;
  /** Group cases by (agent, errorCode, errorPattern). */
  group(q?: FailureCaseQuery): Promise<FailureGroup[]>;
}

export interface FailureGroup {
  /** Stable group key. */
  key: string;
  agent: string;
  errorCode: string;
  errorPattern: string;
  cases: FailureCase[];
  firstSeen: number;
  lastSeen: number;
  toolNames: string[];
}

// ── Success Case ─────────────────────────────────────────────────────

/**
 * A recorded "winding but successful" conversation. Captured when an
 * agent run eventually succeeds after user corrections or multiple
 * turns. Used as raw material for success-driven skill discovery.
 */
export interface SuccessCase {
  /** Stable id. */
  id: string;
  /** When recorded. */
  timestamp: number;
  /** Associated AgentRun id, if known. */
  runId?: string;
  /** Agent that owned the run. */
  agent?: string;
  /** Task summary. */
  task: string;
  /** Full conversation as markdown (or plain text). */
  conversationMarkdown: string;
  /** Total number of user/assistant turns. */
  turnCount: number;
  /** Estimated number of user correction turns. */
  correctionCount: number;
  /** Optional final successful outcome summary. */
  successOutcome?: string;
  /** Optional tags. */
  tags?: string[];
}

/** Filter for querying SuccessCaseStore. */
export interface SuccessCaseQuery {
  agent?: string;
  taskPattern?: string;
  fromTs?: number;
  toTs?: number;
  limit?: number;
  /** Only cases with at least this many turns. */
  minTurns?: number;
  /** Only cases with at least this many corrections. */
  minCorrections?: number;
}

/** Persisted store for winding-but-successful cases. */
export interface ISuccessCaseStore {
  record(sc: SuccessCase): Promise<void>;
  list(q?: SuccessCaseQuery): Promise<SuccessCase[]>;
  count(q?: SuccessCaseQuery): Promise<number>;
  /** Group cases by task pattern / agent for batch extraction. */
  group(q?: SuccessCaseQuery): Promise<SuccessGroup[]>;
}

export interface SuccessGroup {
  /** Stable group key. */
  key: string;
  agent?: string;
  taskPattern: string;
  cases: SuccessCase[];
  firstSeen: number;
  lastSeen: number;
}

/** Result of extracting a skill from a success group. */
export interface SuccessExtractionResult {
  draft: CandidateSkillDraft;
  /** Durable user facts discovered alongside the skill. */
  facts: Array<{ type: string; value: string }>;
}

/** Extractor that turns a success group into a candidate skill draft. */
export interface ISuccessSkillExtractor {
  extract(group: SuccessGroup): Promise<SuccessExtractionResult>;
}

// ── Candidate Skill ─────────────────────────────────────────────────

/**
 * A LLM-proposed Skill, not yet approved. Once accepted, it is
 * promoted to a real Skill in the active SkillIndex.
 */
export interface CandidateSkill {
  /** Stable id (unique across all candidates and approved skills). */
  id: string;
  /** When proposed. */
  proposedAt: number;
  /** Source: which failure group triggered this candidate. */
  sourceGroupKey: string;
  /** Source: failure case ids that contributed. */
  sourceCaseIds: string[];
  /** Proposed Skill record (markdown body + frontmatter). */
  draft: CandidateSkillDraft;
  /** Confidence score (0..1) returned by the LLM extractor. */
  confidence: number;
  /** Validator output. */
  validation?: CandidateValidation;
  /** Current review status. */
  status: 'pending' | 'approved' | 'rejected' | 'superseded';
  /** Reviewer note (if reviewed). */
  reviewNote?: string;
  /** Reviewer id (if reviewed). */
  reviewedBy?: string;
  /** When reviewed. */
  reviewedAt?: number;
}

export interface CandidateSkillDraft {
  name: string;
  description: string;
  tags: string[];
  priority: number;
  mode: 'advisory' | 'strict';
  triggers: {
    intents?: string[];
    fileGlobs?: string[];
    keywords?: string[];
  };
  /** Optional verification commands. */
  verification?: {
    commands?: string[];
    notes?: string[];
  };
  /** Markdown body (Purpose / Use When / Workflow / Do / Do Not / ...) */
  body: string;
}

export interface CandidateValidation {
  valid: boolean;
  issues: Array<{
    severity: 'error' | 'warning';
    message: string;
    field?: string;
  }>;
}

// ── Review Queue ─────────────────────────────────────────────────────

export interface ISkillReviewQueue {
  /** Add a candidate to the queue. */
  enqueue(candidate: CandidateSkill): Promise<void>;
  /** List pending candidates. */
  listPending(): Promise<CandidateSkill[]>;
  /** Get a candidate by id. */
  get(id: string): Promise<CandidateSkill | null>;
  /** Approve a candidate. Promotes draft to active skill. */
  approve(id: string, opts?: { reviewer?: string; note?: string }): Promise<CandidateSkill>;
  /** Reject a candidate. */
  reject(id: string, opts?: { reviewer?: string; note?: string }): Promise<CandidateSkill>;
}

// ── Skill Version Registry ───────────────────────────────────────────

/**
 * Per-skill version chain. Each Skill id can have multiple
 * versions; the registry tracks which is active and supports
 * rollback.
 */
export interface SkillVersion {
  skillId: string;
  version: number;
  createdAt: number;
  /** Source: 'discovery' (auto), 'user' (manual), 'community'. */
  source: 'discovery' | 'user' | 'community';
  /** Status: 'active' | 'inactive' | 'obsolete'. */
  status: 'active' | 'inactive' | 'obsolete';
  /** Pointer to the persisted Skill body. */
  body: string;
  /** Provenance for auditing. */
  provenance?: {
    candidateId?: string;
    failureCaseIds?: string[];
    parentVersion?: number;
  };
}

export interface ISkillVersionRegistry {
  /** Append a new version for a skill id. */
  push(version: SkillVersion): Promise<void>;
  /** List all versions for a skill. */
  list(skillId: string): Promise<SkillVersion[]>;
  /** Get the currently-active version. */
  getActive(skillId: string): Promise<SkillVersion | null>;
  /** Activate a specific version (deactivates others). */
  activate(skillId: string, version: number): Promise<void>;
  /** Roll back to the previous active version. */
  rollback(skillId: string): Promise<SkillVersion | null>;
  /** Mark a version as obsolete (e.g., verification failing). */
  markObsolete(skillId: string, version: number, reason: string): Promise<void>;
}

// ── Obsolescence Detection ──────────────────────────────────────────

export interface ObsolescenceReport {
  skillId: string;
  version: number;
  /** Why this skill is considered obsolete. */
  reasons: Array<
    | { type: 'verification-failed'; commands: string[]; failedAt: number }
    | { type: 'low-success-rate'; rate: number; threshold: number; sample: number }
    | { type: 'replaced'; bySkillId: string; byVersion: number }
    | { type: 'stale'; lastUsedAt: number; thresholdMs: number }
  >;
  suggestedAction: 'deprecate' | 'replace' | 'review';
}

export interface ISkillObsolescenceDetector {
  scan(): Promise<ObsolescenceReport[]>;
}

// ── Composition ─────────────────────────────────────────────────────

/**
 * Combine two or more micro-skills into a macro-skill. Used when
 * the discovery loop notices that several small skills are
 * frequently activated together for the same task type.
 */
export interface SkillCompositionProposal {
  /** Stable id. */
  id: string;
  /** Skill ids being composed (in order). */
  partIds: string[];
  /** Proposed macro-skill draft. */
  draft: CandidateSkillDraft;
  /** Heuristic: how often the parts co-occur (0..1). */
  cooccurrence: number;
  /** Heuristic: composition strength score. */
  score: number;
}

export interface ISkillCompositionEngine {
  /** Look at recent SelectedSkill traces and propose macro-skills. */
  propose(input: { recentSelections: SelectedSkill[][]; minCooccurrence?: number }): Promise<SkillCompositionProposal[]>;
}

// ── Indexer ─────────────────────────────────────────────────────────

/**
 * Fast lookup index over the active skill set. Builds and maintains
 * inverted indexes over intents, keywords, tags, file globs.
 */
export interface ISkillIndexer {
  /** Rebuild the entire index from a flat skill list. */
  rebuild(skills: Skill[]): void;
  /** Add or replace a single skill in the index. */
  upsert(skill: Skill): void;
  /** Remove a skill from the index. */
  remove(id: string): void;
  /** Top-K lookup by free-text query. */
  search(query: string, topK?: number): Skill[];
  /** Index health stats. */
  stats(): { skillCount: number; intentCount: number; keywordCount: number; tagCount: number };
}

// ── Community ───────────────────────────────────────────────────────

/**
 * Opt-in skill sharing across users / projects. Implementations
 * may be local-folder (`~/.ziner/community/`) or remote.
 */
export interface ICommunitySkillStore {
  /** Publish a skill (with provenance). */
  publish(skill: Skill, opts?: { source?: 'user' | 'discovery'; note?: string }): Promise<{ id: string; url?: string }>;
  /** List shared skills. */
  list(): Promise<CommunitySkillEntry[]>;
  /** Pull a specific shared skill into the local active set. */
  pull(id: string): Promise<Skill>;
}

export interface CommunitySkillEntry {
  id: string;
  name: string;
  description?: string;
  tags: string[];
  publisher: string;
  publishedAt: number;
  /** Aggregate community signal (0..1). */
  rating?: number;
  /** Body preview. */
  preview: string;
}

// ── LLM Extractor ────────────────────────────────────────────────────

/**
 * Adapter that converts a FailureGroup into a CandidateSkill draft
 * using an LLM. Concrete implementations may use any ILLMProvider.
 *
 * This interface is intentionally LLM-agnostic so a deterministic
 * (template-based) extractor can be used in tests.
 */
export interface ISkillExtractor {
  /** Extract a draft from a failure group. */
  extract(group: FailureGroup): Promise<CandidateSkillDraft>;
}

// ── Auto-Discovery Orchestrator ──────────────────────────────────────

export interface AutoDiscoveryConfig {
  /** Minimum failures per group before a candidate is proposed. */
  minOccurrences?: number;
  /** Time window in ms to scan for failures. */
  windowMs?: number;
  /** Skip auto-approval — always enqueue for review. */
  alwaysReview?: boolean;
  /** Confidence threshold for auto-extraction. */
  minConfidence?: number;
  /**
   * Which sources to scan. 'failure' preserves the original behaviour;
   * 'success' scans winding-but-successful cases; 'all' scans both.
   * Default 'failure'.
   */
  source?: 'failure' | 'success' | 'all';
  /** Minimum turns for a success case to be considered winding. */
  successMinTurns?: number;
  /** Minimum user corrections for a success case to be considered winding. */
  successMinCorrections?: number;
}

export interface AutoDiscoveryReport {
  generatedAt: number;
  scannedCases: number;
  scannedGroups: number;
  /** Success-only stats (present when source includes 'success'). */
  scannedSuccessCases?: number;
  scannedSuccessGroups?: number;
  /** Durable facts extracted from success cases. */
  discoveredFacts?: Array<{ type: string; value: string }>;
  proposedCandidates: CandidateSkill[];
  skipped: Array<{ groupKey: string; reason: string }>;
}
