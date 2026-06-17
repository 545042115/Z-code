// Harness module — single import surface.
//
//   import { BenchmarkRunner, LocalSandbox, scoreSandboxResult } from '../harness';

export {
  LocalSandbox,
  StubSandbox,
  type SandboxExecutor,
  type SandboxSpec,
  type SandboxResult,
  type SandboxMount,
} from './sandbox';
export {
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
} from './rubric';
export {
  BenchmarkRunner,
  suiteFromCases,
  type BenchmarkCaseSpec,
  type BenchmarkSuiteSpec,
  type BenchmarkRunOptions,
  type BenchmarkRunSummary,
} from './benchmark-runner';
export {
  CandidateAdapter,
  type CandidateOptions,
  type EvaluateOptions,
} from './candidate-adapter';
