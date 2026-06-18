// Context Provider Contracts — interface for V2 context providers.
//
// `IContextProvider` is a single source of context chunks (code,
// search, RAG, retrieval, repo-map, etc.). The Context framework in
// `@z-assistant/runtime` aggregates multiple providers under a
// shared token budget.

import type { TaskContext } from './agent';

// ── Context chunk ─────────────────────────────────────────────────────

export interface ContextChunk {
  /** Stable id within the provider. */
  id: string;
  /** Provider name; matches `IContextProvider.name`. */
  source: string;
  /** Free-form content; truncated by the budget manager. */
  content: string;
  /** 0-1 relevance score; sorted descending. */
  score: number;
  /** Free-form tags for filtering, e.g. ["file:src/foo.ts"]. */
  tags: string[];
  /** Optional URI for click-through in the UI. */
  uri?: string;
}

// ── Context source ───────────────────────────────────────────────────

export interface ContextSource {
  /** Provider name. */
  name: string;
  /** Human-readable role, e.g. "code retrieval". */
  role: string;
  /** Priority for budget allocation; higher = preferred. */
  priority: number;
  /** Soft cap; budget manager can override. */
  maxChunks?: number;
}

// ── IContextProvider ──────────────────────────────────────────────────

export interface IContextProvider {
  readonly name: string;
  /**
   * Fetch chunks relevant to `query`. Implementation is read-only;
   * the provider MUST NOT mutate `ctx` (the framework manages state).
   */
  fetch(ctx: TaskContext, query: string, limit?: number): Promise<ContextChunk[]>;
  /** Static metadata about this provider. */
  source(): ContextSource;
}
