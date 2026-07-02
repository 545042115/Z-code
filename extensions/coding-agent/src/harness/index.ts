// Harness module — single import surface.
//
// Phase 6A: this is now a thin shim over the V2 Evaluation framework
// (`@ziner/runtime` re-exports the `evaluation` subpackage).
// All public symbols live there.
//
// V1 callers that previously did:
//   import { BenchmarkRunner, LocalSandbox, ... } from '../harness';
// keep working unchanged because the V2 framework re-exports the
// same public surface with identical signatures.

export {
  LocalSandbox,
  StubSandbox,
  type SandboxExecutor,
  type SandboxSpec,
  type SandboxResult,
  type SandboxMount,
  scoreSandboxResult,
  makeEvaluation,
  exitCodeZero,
  noTimeout,
  noStderr,
  stdoutMatches,
  minArtifacts,
  hasArtifact,
  durationUnderMs,
  allOf,
  type RubricCheck,
  type RubricSpec,
  BenchmarkRunner,
  suiteFromCases,
  type BenchmarkCaseSpec,
  type BenchmarkSuiteSpec,
  type BenchmarkRunOptions,
  type BenchmarkRunSummary,
  CandidateAdapter,
  type CandidateOptions,
  type EvaluateOptions,
} from '@ziner/runtime';
