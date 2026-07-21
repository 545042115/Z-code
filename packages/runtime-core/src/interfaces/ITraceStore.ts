// ITraceStore — trace/run storage abstraction.
// Desktop: backed by @ziner/trace (JSONL + SQLite).
// Mobile: backed by IndexedDB.

import type { AgentRun, AgentSpan } from '@ziner/contracts';

export interface ITraceStore {
  /** Start a new run and return it. */
  startRun(task: string, sessionId: string, model: string): Promise<AgentRun>;
  /** End a run and compute duration. */
  endRun(runId: string, status: 'success' | 'failed' | 'cancelled'): Promise<void>;
  /** Record a span within a run. */
  recordSpan(runId: string, span: Omit<AgentSpan, 'id' | 'runId' | 'traceId'> & Partial<Pick<AgentSpan, 'id' | 'traceId'>>): Promise<AgentSpan>;
  /** List recent runs (newest first). */
  listRuns(limit?: number, sessionId?: string): Promise<TraceRunSummary[]>;
  /** Get a single run with full span details. */
  getRun(id: string): Promise<TraceRunDetail | undefined>;
  /** List sessions (groups of runs). */
  listSessions(limit?: number): Promise<TraceSessionSummary[]>;
  /** Delete one run. */
  deleteRun(id: string): Promise<void>;
  /** Clear all trace history. */
  clear(): Promise<void>;
  /** Close the store. */
  close(): Promise<void>;
}

/** Summary of a trace run for list views. */
export interface TraceRunSummary {
  id: string;
  sessionId: string;
  userMessage: string;
  assistantMessage?: string;
  startTime: number;
  durationMs?: number;
  status: 'running' | 'success' | 'failed' | 'cancelled';
  llmCalls: number;
  toolCalls: number;
  totalTokens?: number;
  totalCostUsd?: number;
  skills?: string[];
  mcpServers?: string[];
}

/** Full run detail with spans. */
export interface TraceRunDetail extends TraceRunSummary {
  endTime?: number;
  spans: AgentSpan[];
  error?: string;
}

/** Session summary for grouping runs. */
export interface TraceSessionSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}
