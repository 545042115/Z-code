// @z-assistant/runtime — reflection
//
// Universal Reflection framework. Pure Node, no vscode.
//
// Provides generic types and pure data transforms for the reflection
// loop used by every agent's self-correction step. Agent-specific
// reflection engines (Coding's `ReflectionEngine`, etc.) sit on top
// of this framework and supply agent-specific heuristics.
//
//   FailureCategory   — dominant failure type (build / test / lint / logic)
//   Severity          — critical / high / medium / low
//   VerificationResult + VerificationDiagnostic — generic shapes
//   normalizeErrorPattern() — stable pattern for an error message
//   classifyFailure()       — pick dominant FailureCategory
//   analyzeFailures()       — FailureAnalysis from a list of verifications
//   shouldContinue()        — progress-aware decision to retry
//   buildReflectionHint()   — text hint to inject into the next prompt
//   reflectOnResults()      — convenience wrapper

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
} from './reflection';
