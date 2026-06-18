// @z-assistant/runtime — evaluation
//
// Universal Eval framework (Phase 3). Pure Node, no vscode.
//
//   - Sandbox:        LocalSandbox / StubSandbox / SandboxExecutor interface
//   - Rubric:         RubricSpec + scoreSandboxResult + built-in checks
//   - BenchmarkRunner: runs a BenchmarkSuiteSpec, records Evaluations
//   - CandidateAdapter: runs an IAgent in the sandbox, scores via Rubric
//
// Harness/eval data shapes (Benchmark, Evaluation, Baseline, etc.) are
// pure types and live in `@z-assistant/contracts` (see contracts/eval.ts).
// Per ADR 4.2, the V1 Coding-specific eval cases (`harness/eval-cases/`,
// the `evaluations-panel.ts` Webview) stay in the V1 Connector.

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
