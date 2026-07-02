// V1-specific Trace Instrumentation adapter.
//
// This file is the V1 Connector layer over `@ziner/trace`. The
// V2 `Instrumenter` is duck-typed and only knows about three method
// shapes (generate / execute / run). The V1 LLM / Tool / Pipeline types
// match those shapes, so the adapter is a thin typed wrapper that
// pins the V1 type contract.

import { Instrumenter } from '@ziner/trace';
import type { RunTracker } from '@ziner/trace';
import type { LLMProvider, GenerateRequest } from '../llm/llm-provider';
import type { ToolRegistry } from '../tools/tool-registry';
import type { AgentPipeline } from '../agent/agent-pipeline';
import type { PipelineInput, PipelineOutput } from '../agent/pipeline-types';
import type { ModelRef } from '@ziner/contracts';

export interface TraceInstrumentationOptions {
  tracker: RunTracker;
}

/**
 * V1-typed wrapper around the V2 `Instrumenter`. Preserves the
 * pre-migration API: `wrapLLM(llm, model)`, `wrapToolRegistry(tools)`,
 * `wrapPipeline(pipeline)`. All Span / token / error logic lives in
 * the V2 package.
 */
export class TraceInstrumentation {
  private readonly _inner: Instrumenter;
  constructor(opts: TraceInstrumentationOptions) {
    this._inner = new Instrumenter({ tracker: opts.tracker });
  }

  /** Wrap a V1 `LLMProvider` so every call emits an `llm` Span. */
  wrapLLM<L extends LLMProvider>(llm: L, model: ModelRef): L {
    return this._inner.wrapLLM(llm as unknown as Parameters<Instrumenter['wrapLLM']>[0], model) as unknown as L;
  }

  /** Wrap a V1 `ToolRegistry` so every `execute()` emits a `tool` Span. */
  wrapToolRegistry<T extends ToolRegistry>(tools: T): T {
    return this._inner.wrapToolRegistry(tools as unknown as Parameters<Instrumenter['wrapToolRegistry']>[0]) as unknown as T;
  }

  /** Wrap a V1 `AgentPipeline` so `run()` emits a `planner` Span. */
  wrapPipeline<P extends AgentPipeline>(pipeline: P): P {
    return this._inner.wrapPipeline(pipeline as unknown as Parameters<Instrumenter['wrapPipeline']>[0]) as unknown as P;
  }
}

// Re-export the request type for downstream call sites that need it.
export type { GenerateRequest, PipelineInput, PipelineOutput };
