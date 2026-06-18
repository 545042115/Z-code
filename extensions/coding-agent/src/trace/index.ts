// Shim: V1 extension → @z-assistant/trace
// Migration re-export. See ADR 0007 (Phase 6 Runtime decoupling).
//
// The V1-specific `TraceInstrumentation` lives in `trace-adapter.ts`
// because it depends on V1 types (LLMProvider, ToolRegistry, AgentPipeline).
// The runtime primitives (Span, RunTracker, TraceManager) and the
// duck-typed `Instrumenter` are re-exported from V2 directly.

export {
  Span,
  TraceManager,
  RunTracker,
  type SpanOptions,
  type RunStartOptions,
  type RunFinishOptions,
  type TraceManagerOptions,
} from '@z-assistant/trace';

// Re-export the V1-specific adapter (a thin wrapper that uses V1 LLM
// / Tool / Pipeline types but delegates to the V2 Instrumenter).
export { TraceInstrumentation, type TraceInstrumentationOptions } from './trace-adapter';
