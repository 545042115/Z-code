// Trace Instrumentation — adapters that wrap existing LLM / Tool / Pipeline
// components with Span emission, without modifying their source.
//
// Usage:
//   const tracer = new TraceInstrumentation({ tracker, store });
//   const wrappedLlm = tracer.wrapLLM(existingLlm, { model });
//   const wrappedTools = tracer.wrapToolRegistry(existingTools);
//   const wrappedPipeline = tracer.wrapPipeline(existingPipeline);
//
// Each wrapper starts a Span on entry, records input/output, captures
// errors via `classify()`, and ends the Span on exit. Token usage is
// recorded on `llm` Spans; tool execution time on `tool` Spans.

import type { LLMProvider, GenerateRequest, Message } from '../llm/llm-provider';
import type { ToolRegistry } from '../tools/tool-registry';
import type { AgentPipeline } from '../agent/agent-pipeline';
import type { PipelineInput, PipelineOutput } from '../agent/pipeline-types';
import type { RunTracker } from './run-tracker';
import { classify } from '../infra/errors';
import { computeCost } from '../infra/cost';
import type { ModelRef, ErrorRef } from '../contracts';

export interface TraceInstrumentationOptions {
  tracker: RunTracker;
}

/**
 * Wraps LLM / Tool / Pipeline components with Span emission.
 * One instance per Run; construct after `TraceManager.startRun()`.
 */
export class TraceInstrumentation {
  constructor(private readonly opts: TraceInstrumentationOptions) {}

  // ── LLM ──────────────────────────────────────────────────────────────

  /**
   * Wrap an LLMProvider so every `generate` / `generateStream` call
   * emits an `llm` Span with input/output + token usage.
   */
  wrapLLM<L extends LLMProvider>(llm: L, model: ModelRef): L {
    const tracker = this.opts.tracker;
    const self = this;

    const wrapped = Object.create(llm) as L;
    wrapped.generate = async function (req: GenerateRequest): Promise<string> {
      const span = tracker.startSpan({
        name: `llm:${model.name}`,
        type: 'llm',
        input: self._summarizeRequest(req),
        attributes: {
          'gen_ai.system': model.provider,
          'gen_ai.request.model': model.name,
        },
      });
      try {
        const out = await llm.generate(req);
        span.setOutput(self._summarizeResponse(out));
        // Token usage is best-effort; provider may not report it.
        const tokensIn = self._estimateTokens(req);
        const tokensOut = self._estimateTokens(out);
        const cost = computeCost(model, tokensIn, tokensOut);
        span.addTokens(tokensIn, tokensOut, cost);
        await tracker.addUsage(tokensIn, tokensOut);
        span.end();
        return out;
      } catch (e) {
        span.fail(classify(e) as ErrorRef);
        span.end();
        throw e;
      }
    };

    wrapped.generateStream = async function* (req: GenerateRequest): AsyncIterable<string> {
      const span = tracker.startSpan({
        name: `llm:${model.name}#stream`,
        type: 'llm',
        input: self._summarizeRequest(req),
        attributes: {
          'gen_ai.system': model.provider,
          'gen_ai.request.model': model.name,
          'gen_ai.streaming': true,
        },
      });
      let acc = '';
      try {
        for await (const chunk of llm.generateStream(req)) {
          acc += chunk;
          span.addEvent('stream.chunk', { chars: chunk.length });
          yield chunk;
        }
        span.setOutput(self._summarizeResponse(acc));
        const tokensIn = self._estimateTokens(req);
        const tokensOut = self._estimateTokens(acc);
        const cost = computeCost(model, tokensIn, tokensOut);
        span.addTokens(tokensIn, tokensOut, cost);
        await tracker.addUsage(tokensIn, tokensOut);
        span.end();
      } catch (e) {
        span.fail(classify(e) as ErrorRef);
        span.end();
        throw e;
      }
    };

    // FIM and other methods pass through unchanged.
    return wrapped;
  }

  // ── ToolRegistry ─────────────────────────────────────────────────────

  /**
   * Wrap a ToolRegistry so every `execute()` call emits a `tool` Span.
   */
  wrapToolRegistry<T extends ToolRegistry>(tools: T): T {
    const tracker = this.opts.tracker;
    const original = tools.execute.bind(tools);
    const self = this;

    const wrapped = Object.create(tools) as T;
    wrapped.execute = async function (name: string, params: Record<string, unknown>): Promise<string> {
      const span = tracker.startSpan({
        name: `tool:${name}`,
        type: 'tool',
        input: self._safeJson(params),
        attributes: {
          'tool.name': name,
        },
      });
      span.addEvent('tool.start');
      const t0 = Date.now();
      try {
        const out = await original(name, params);
        span.setOutput(self._truncate(out));
        span.setAttribute('tool.duration_ms', Date.now() - t0);
        span.addEvent('tool.end', { ok: true });
        span.end();
        return out;
      } catch (e) {
        span.setAttribute('tool.duration_ms', Date.now() - t0);
        span.fail(classify(e) as ErrorRef);
        span.addEvent('tool.end', { ok: false });
        span.end();
        throw e;
      }
    };
    return wrapped;
  }

  // ── Pipeline ─────────────────────────────────────────────────────────

  /**
   * Wrap an AgentPipeline so `run()` emits a `planner` Span.
   * Per-stage timing is recorded by the pipeline itself (console.warn);
   * we only wrap the top-level call to avoid coupling to internal APIs.
   */
  wrapPipeline<P extends AgentPipeline>(pipeline: P): P {
    const tracker = this.opts.tracker;
    const originalRun = pipeline.run.bind(pipeline);

    const wrapped = Object.create(pipeline) as P;
    wrapped.run = async function (input: PipelineInput): Promise<PipelineOutput> {
      const span = tracker.startSpan({
        name: 'pipeline:pre-analysis',
        type: 'planner',
        input: { task: input.userRequest?.slice(0, 200) },
      });
      try {
        const out = await originalRun(input);
        span.setOutput({
          hasPlan: !!out.plan,
          skillsCount: out.selectedSkills?.length ?? 0,
          hasDiscovery: !!out.discoveryReport,
        });
        span.end();
        return out;
      } catch (e) {
        span.fail(classify(e) as ErrorRef);
        span.end();
        throw e;
      }
    };
    return wrapped;
  }

  // ── Helpers ──────────────────────────────────────────────────────────

  /** Rough token estimate: 1 token ≈ 4 chars. Good enough for budgeting. */
  private _estimateTokens(s: string | object): number {
    const text = typeof s === 'string' ? s : JSON.stringify(s);
    return Math.ceil(text.length / 4);
  }

  private _summarizeRequest(req: GenerateRequest): unknown {
    // Keep it small; full prompt may be huge.
    return {
      messages: (req.messages ?? []).map((m) => ({
        role: m.role,
        content: typeof m.content === 'string' ? this._truncate(m.content, 500) : '[complex]',
      })),
      stream: req.stream,
    };
  }

  private _summarizeResponse(out: string): unknown {
    return this._truncate(out, 1000);
  }

  private _truncate(s: string, max = 2000): string {
    if (s.length <= max) return s;
    return s.slice(0, max) + `... [+${s.length - max} chars]`;
  }

  private _safeJson(v: unknown): unknown {
    try {
      JSON.stringify(v);
      return v;
    } catch {
      return '[unserializable]';
    }
  }
}
