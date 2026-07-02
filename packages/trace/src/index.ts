// @ziner/trace
//
// Trace runtime for the V2 Assistant. Provides:
//   - Span / RunTracker / TraceManager: the core execution-time tracing API
//   - Instrumenter: duck-typed wrappers for LLM / Tool / Pipeline
//   - Projections: pure functions for UI-friendly aggregation
//
// This package is the single import surface for V2 trace consumers:
//
//   import {
//     Span, RunTracker, TraceManager, Instrumenter,
//     projectRunSummary, listRunSummaries, ...
//   } from '@ziner/trace';
//
// Pure Node; no vscode dependency. Used by:
//   - apps/cli           (CLI agent runtime)
//   - apps/desktop       (desktop app)
//   - apps/vscode-connector (V2 thin wrapper over the V1 extension)
//   - extensions/coding-agent (V1 shim re-exports this)

export { Span, type SpanOptions } from './span';
export {
  RunTracker,
  TraceManager,
  type RunStartOptions,
  type RunFinishOptions,
  type TraceManagerOptions,
} from './run-tracker';
export {
  Instrumenter,
  type InstrumenterOptions,
  type InstrumentableLLM,
  type InstrumentableTool,
  type InstrumentablePipeline,
} from './instrumentation';
export {
  // UI shapes
  type RunSummary,
  type SpanNode,
  type SpanEventLite,
  // Run / Span projections
  projectRunSummary,
  buildChildCountMap,
  projectSpanNode,
  projectSpanEvent,
  // Evaluation projections
  computeScoreTrend,
  // Baseline projections
  buildBaseline,
  diffBaseline,
  // Optimizer projections
  projectToolUsage,
  projectSkillUsage,
  projectVariantStats,
  // Store-backed wrappers
  listRunSummaries,
  listSpanNodes,
  readRunEvents,
  listToolUsage,
  listSkillUsage,
} from './projections';
