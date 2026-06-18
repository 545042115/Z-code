// V1 evolution.ts — Phase 6A shim.
//
// This file is kept for backward compatibility with any V1 code that
// imports from `../evolution/evolution` directly. The real
// implementation now lives in V2
// (`@z-assistant/runtime`, re-exported from the `evolution` subpackage).
//
// Re-exports are identical to the V2 public surface so call sites
// and tests don't need to be modified.

export {
  EvolutionEngine,
  fingerprintRun,
  clusterFingerprints,
  normalizePattern,
  suggestForCluster,
  type FailureFingerprint,
  type FailureCluster,
  type EvolutionReport,
  type EvolutionSuggestion,
  type PromptSuggestion,
  type ToolSuggestion,
  type ConfigSuggestion,
  type SuggestionKind,
} from '@z-assistant/runtime';
