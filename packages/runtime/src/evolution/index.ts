// @z-assistant/runtime — evolution
//
// Universal Evolution engine framework. Phase-5 self-improvement loop
// per V2_VISION and ADR-0004. Pure Node, no vscode.
//
// The framework exports:
//   - Pure data shapes (FailureFingerprint, FailureCluster, etc.)
//   - Pure transforms (fingerprintRun, normalizePattern,
//     clusterFingerprints, suggestForCluster)
//   - EvolutionEngine — generates an EvolutionReport from the Store
//
// The UI flow (rendering the report, gating Apply behind human
// approval, candidate A/B pool, proposal log) lives in the V1
// Connector (`EvolutionPanel`).

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
} from './evolution';

export { BackgroundScheduler, type BackgroundSchedulerOptions } from './scheduler';
