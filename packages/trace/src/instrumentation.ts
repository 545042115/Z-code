// V2 Trace Instrumentation — duck-typed wrappers for arbitrary
// LLM / Tool / Pipeline components.
//
// Why duck-typed and not a strict interface?
//   - The V2 trace package must not depend on any specific LLM SDK,
//     tool runtime, or pipeline implementation. Each Connector (VSCode,
//     CLI, desktop) brings its own types and adapts them via this API.
//   - The wrappers only need three method shapes: `generate(req)`,
//     `execute(name, params)`, `run(input)`. We type those via
//     `InstrumentableLLM`, `InstrumentableTool`, `InstrumentablePipeline`.
//
// Usage (V1 Connector side):
//   const tracer = new Instrumenter({ tracker });
//   const wrappedLlm = tracer.wrapLLM(llm, { provider: 'openai', name: 'gpt-4o' });
//   const wrappedTools = tracer.wrapToolRegistry(tools);
//   const wrappedPipeline = tracer.wrapPipeline(pipeline);
//
// Each wrapper starts a Span on entry, records input/output, captures
// errors via `classify()`, and ends the Span on exit. Token usage is
// recorded on `llm` Spans; tool execution time on `tool` Spans.

import type { ModelRef, ErrorRef } from '@ziner/contracts';
import { classify } from '@ziner/infra-errors';
import { computeCost } from '@ziner/infra-cost';
import type { RunTracker } from './run-tracker';

export interface InstrumenterOptions {
  tracker: RunTracker;
}

// ── Duck-typed shapes ─────────────────────────────────────────────────

/** Minimal LLM shape: { generate, generateStream? }. */
export interface InstrumentableLLM {
  generate(req: { messages: Array<{ role: string; content: unknown }>; stream?: boolean }): Promise<string>;
  generateStream?(req: { messages: Array<{ role: string; content: unknown }>; stream?: boolean }): AsyncIterable<string>;
  [k: string]: unknown;
}

/** Minimal Tool-registry shape: { execute(name, params) }. */
export interface InstrumentableTool {
  execute(name: string, params: Record<string, unknown>): Promise<string>;
  [k: string]: unknown;
}

/** Minimal Pipeline shape: { run(input) }. */
export interface InstrumentablePipeline {
  run(input: { userRequest?: string; [k: string]: unknown }): Promise<{
    plan?: unknown;
    selectedSkills?: unknown[];
    discoveryReport?: unknown;
    [k: string]: unknown;
  }>;
  [k: string]: unknown;
}

// ── Instrumenter ──────────────────────────────────────────────────────

/**
 * Wraps LLM / Tool / Pipeline components with Span emission.
 * One instance per Run; construct after `TraceManager.startRun()`.
 */
export class Instrumenter {
  constructor(private readonly opts: InstrumenterOptions) {}

  // ── LLM ──────────────────────────────────────────────────────────────

  /**
   * Wrap an LLM-shaped object so every `generate` / `generateStream` call
   * emits an `llm` Span with input/output + token usage.
   */
  wrapLLM<L extends InstrumentableLLM>(llm: L, model: ModelRef): L {
    const tracker = this.opts.tracker;
    const self = this;

    const wrapped = Object.create(llm) as L;
    wrapped.generate = async function (req: { messages: Array<{ role: string; content: unknown }>; stream?: boolean }): Promise<string> {
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

    if (typeof llm.generateStream === 'function') {
      wrapped.generateStream = async function* (req: { messages: Array<{ role: string; content: unknown }>; stream?: boolean }): AsyncIterable<string> {
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
          for await (const chunk of llm.generateStream!(req)) {
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
    }

    return wrapped;
  }

  // ── ToolRegistry ─────────────────────────────────────────────────────

  /**
   * Wrap a Tool-shaped object so every `execute()` call emits a `tool` Span.
   */
  wrapToolRegistry<T extends InstrumentableTool>(tools: T): T {
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
   * Wrap a Pipeline-shaped object so `run()` emits a `planner` Span.
   * Per-stage timing is recorded by the pipeline itself; we only wrap
   * the top-level call to avoid coupling to internal APIs.
   */
  wrapPipeline<P extends InstrumentablePipeline>(pipeline: P): P {
    const tracker = this.opts.tracker;
    const originalRun = pipeline.run.bind(pipeline);

    const wrapped = Object.create(pipeline) as P;
    wrapped.run = async function (input: { userRequest?: string; [k: string]: unknown }): Promise<{
      plan?: unknown;
      selectedSkills?: unknown[];
      discoveryReport?: unknown;
      [k: string]: unknown;
    }> {
      const span = tracker.startSpan({
        name: 'pipeline:pre-analysis',
        type: 'planner',
        input: { task: input.userRequest?.slice(0, 200) },
      });
      try {
        const out = await originalRun(input);
        span.setOutput({
          hasPlan: !!out.plan,
          skillsCount: (out.selectedSkills?.length ?? 0),
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

  private _summarizeRequest(req: { messages?: Array<{ role: string; content: unknown }>; stream?: boolean }): unknown {
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
