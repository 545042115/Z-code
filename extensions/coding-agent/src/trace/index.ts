// Trace module — single import surface.
//
//   import { TraceManager, Span, TraceInstrumentation } from '../trace';
//
// See `run-tracker.ts` for the public API, `span.ts` for Span details,
// and `instrumentation.ts` for wrapping existing LLM/Tool/Pipeline.

export { Span, type SpanOptions } from './span';
export {
  RunTracker,
  TraceManager,
  type RunStartOptions,
  type RunFinishOptions,
  type TraceManagerOptions,
} from './run-tracker';
export { TraceInstrumentation, type TraceInstrumentationOptions } from './instrumentation';
