// Evolution module — single import surface.
//
// Phase 6A: this is now a thin shim over the V2 Evolution framework
// (`@z-assistant/runtime` re-exports the `evolution` subpackage).
// Only the V1 `EvolutionPanel` (VSCode Webview) stays in V1.
//
// V1 callers that previously did:
//   import { EvolutionEngine, fingerprintRun, ... } from '../evolution';
// keep working unchanged because the V2 framework re-exports the
// same public surface with identical signatures.

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

export { EvolutionPanel } from './evolution-panel';
