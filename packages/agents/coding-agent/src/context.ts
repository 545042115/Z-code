// CodingContextProvider — V2 `IContextProvider` adapter backed by V1's
// `extensions/coding-agent/src/context/` (retrieval, repo-map, builder).
//
// Phase 6A: skeleton. R7 wires the real V1 context providers behind
// this. The shape is fixed: implements V2 `IContextProvider` so V2
// Apps / Orchestrator can fetch chunks for a task.

import type {
  ContextChunk,
  ContextSource,
  IContextProvider,
  TaskContext,
} from '@ziner/contracts';

export interface CodingContextOptions {
  impl?: IContextProvider;
  /** Static source metadata; defaults to a single "coding" source. */
  source?: ContextSource;
}

export class CodingContextProvider implements IContextProvider {
  readonly name: string;
  private _source: ContextSource;

  constructor(private readonly opts: CodingContextOptions = {}) {
    this.name = opts.impl?.name ?? 'coding-context';
    this._source = opts.source ?? {
      name: this.name,
      role: 'code retrieval + repo map + builder',
      priority: 50,
    };
  }

  async fetch(ctx: TaskContext, query: string, limit?: number): Promise<ContextChunk[]> {
    if (this.opts.impl) return this.opts.impl.fetch(ctx, query, limit);
    // Phase 6A stub — R7 delegates to V1 retrieval/builder/repo-map
    return [];
  }

  source(): ContextSource {
    return this._source;
  }
}
