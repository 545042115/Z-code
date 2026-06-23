// @z-assistant/runtime — skills
//
// Universal Skills framework. Pure Node, no vscode.
//
// Skill files are markdown documents with YAML frontmatter under
// `.skills/**/SKILL.md`. The framework defines:
//   - canonical types (Skill / SkillFrontmatter / SkillSections / SelectedSkill)
//   - pure helpers (validateSkill, scoreSkill, matchGlob, selectSkills)
//   - **skill-parser**: YAML frontmatter parser + markdown section splitter
//   - **skill auto-discovery** (P1-3): failure case store, candidate
//     extractor, validator, indexer, version registry, obsolescence
//     detector, composition engine, review queue, community store and
//     the AutoDiscoveryEngine orchestrator.
//
// Agent-specific loaders (Coding's `skill-loader.ts`) sit on top of
// this framework and supply the file-system scan that builds a SkillIndex.
//
// This file is the framework part. It is shared by every agent
// and is the contract that V2 Apps rely on.

export {
  validateSkill,
  scoreSkill,
  matchGlob,
  selectSkills,
  type SkillMode,
  type SkillTriggers,
  type SkillVerification,
  type SkillFrontmatter,
  type SkillSections,
  type Skill,
  type SkillSelectionReason,
  type SelectedSkill,
  type SkillIndex,
  type SkillSelectionInput,
  type SkillValidationIssue,
  type SkillValidationResult,
} from './skills';

export {
  parseSkillFile,
  parseFrontmatter,
  parseSections,
} from './skill-parser';

// ── P1-3 Skill Auto-Discovery ────────────────────────────────────────

export {
  JsonlFailureCaseStore,
  NoopFailureCaseStore,
  createJsonlFailureCaseStore,
  failureCaseFromRun,
  type JsonlFailureCaseStoreOptions,
} from './failure-cases';

export {
  TemplateSkillExtractor,
  LLMSkillExtractor,
  validateExtractedDraft,
  extractToCandidate,
  type LLMSkillExtractorOptions,
  type ExtractToCandidateOptions,
  type DraftValidationResult,
} from './llm-extract';

export {
  validateCandidate,
} from './validator';

export {
  InMemorySkillIndexer,
} from './indexer';

export {
  JsonFileSkillVersionRegistry,
  NoopSkillVersionRegistry,
  type JsonFileSkillVersionRegistryOptions,
} from './versions';

export {
  HeuristicObsolescenceDetector,
  type HeuristicObsolescenceDetectorOptions,
  type ObsolescenceScanInput,
} from './obsolescence';

export {
  CooccurrenceCompositionEngine,
  type CooccurrenceProposeInput,
} from './composition';

export {
  JsonFileSkillReviewQueue,
  type JsonFileSkillReviewQueueOptions,
} from './review';

export {
  LocalCommunitySkillStore,
  type LocalCommunitySkillStoreOptions,
} from './community';

export {
  AutoDiscoveryEngine,
  type AutoDiscoveryEngineOptions,
} from './auto-discovery';

export {
  HistoryMarkdownSuccessCaseStore,
  type HistorySuccessStoreOptions,
} from './history-success-store';

export {
  LlmSuccessSkillExtractor,
  type LlmSuccessExtractorOptions,
} from './llm-success-extractor';
