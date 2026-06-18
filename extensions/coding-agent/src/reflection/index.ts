// Reflection module - single import surface.
//
// Phase 6A: this is now a thin shim over the V2 Reflection framework
// (`@z-assistant/runtime` re-exports the `reflection` subpackage).
//
// The Coding-specific `ReflectionEngine` (which uses
// `RuntimeVerifier`) stays in V1 (`reflection-engine.ts` in this
// dir). The framework part is in V2.

export {
  normalizeErrorPattern,
  classifyFailure,
  analyzeFailures,
  shouldContinue,
  buildReflectionHint,
  reflectOnResults,
  type FailureCategory,
  type Severity,
  type VerificationDiagnostic,
  type VerificationResult,
  type FailureAnalysis,
  type ErrorPattern,
} from '@z-assistant/runtime';

export { ReflectionEngine } from './reflection-engine';
