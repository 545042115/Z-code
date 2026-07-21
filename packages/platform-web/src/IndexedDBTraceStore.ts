// IndexedDBTraceStore — TraceLogger for Web/Mobile Runtime
//
// Records agent run timeline into IndexedDB.
// Each "run" represents one user message → assistant response cycle.
// Stores: span start/end, tool calls (with results), LLM usage, errors.
// Used by the Trace panel to render a waterfall view.

import { getStorage } from './IndexedDBStorage';

export interface TraceSpan {
  id: string;
  type: 'llm' | 'tool' | 'orchestrator';
  name: string;
  startTime: number;
  endTime?: number;
  durationMs?: number;
  status: 'ok' | 'error' | 'pending';
  /** Input payload (e.g. messages array). */
  input?: unknown;
  /** Output payload (e.g. response content). */
  output?: unknown;
  /** Error message if status === 'error'. */
  error?: string;
  /** Metadata (e.g. model, tokens). */
  metadata?: Record<string, unknown>;
}

export interface TraceRun {
  id: string;
  sessionId: string;
  userMessage: string;
  assistantMessage?: string;
  startTime: number;
  endTime?: number;
  durationMs?: number;
  status: 'running' | 'ok' | 'error';
  /** Ordered list of spans within this run. */
  spans: TraceSpan[];
  /** Aggregated metrics. */
  metrics?: {
    llmCalls: number;
    toolCalls: number;
    totalTokens?: number;
    inputTokens?: number;
    outputTokens?: number;
  };
  /** Active SKILL ids selected for this run. */
  skills?: string[];
  /** Active MCP server names. */
  mcpServers?: string[];
  error?: string;
}

export interface TraceSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

export class TraceLogger {
  private currentRun: TraceRun | null = null;
  private spanCounter = 0;

  /** Start a new run. Returns the run id. */
  startRun(opts: { sessionId: string; userMessage: string; skills?: string[]; mcpServers?: string[] }): string {
    const id = `run-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    this.currentRun = {
      id,
      sessionId: opts.sessionId,
      userMessage: opts.userMessage,
      startTime: Date.now(),
      status: 'running',
      spans: [],
      skills: opts.skills,
      mcpServers: opts.mcpServers,
    };
    this.persistSessionHeader(opts.sessionId, opts.userMessage);
    return id;
  }

  /** End the current run. */
  async endRun(opts: { assistantMessage: string; error?: string }): Promise<void> {
    if (!this.currentRun) return;
    const run = this.currentRun;
    run.endTime = Date.now();
    run.durationMs = run.endTime - run.startTime;
    run.assistantMessage = opts.assistantMessage;
    run.status = opts.error ? 'error' : 'ok';
    run.error = opts.error;
    // Aggregate metrics from spans
    const llmSpans = run.spans.filter((s) => s.type === 'llm');
    const toolSpans = run.spans.filter((s) => s.type === 'tool');
    let totalTokens = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    for (const s of llmSpans) {
      const m = s.metadata ?? {};
      totalTokens += (m.totalTokens as number) ?? 0;
      inputTokens += (m.inputTokens as number) ?? 0;
      outputTokens += (m.outputTokens as number) ?? 0;
    }
    run.metrics = {
      llmCalls: llmSpans.length,
      toolCalls: toolSpans.length,
      totalTokens: totalTokens || undefined,
      inputTokens: inputTokens || undefined,
      outputTokens: outputTokens || undefined,
    };
    await getStorage().put('traces', run);
    await this.touchSession(run.sessionId);
    this.currentRun = null;
  }

  /** Record a span (sync or async). Returns a handle to end the span. */
  recordSpan(span: Omit<TraceSpan, 'id' | 'startTime' | 'status'> & { status?: TraceSpan['status'] }): { id: string; end: (output?: unknown, error?: string) => Promise<void> } {
    if (!this.currentRun) {
      // No active run: create a synthetic one
      const id = `span-${Date.now()}-${++this.spanCounter}`;
      return {
        id,
        end: async () => { /* no-op */ },
      };
    }
    const spanId = `span-${Date.now()}-${++this.spanCounter}`;
    const fullSpan: TraceSpan = {
      id: spanId,
      startTime: Date.now(),
      status: span.status ?? 'pending',
      ...span,
    };
    this.currentRun.spans.push(fullSpan);
    return {
      id: spanId,
      end: async (output?: unknown, error?: string) => {
        fullSpan.endTime = Date.now();
        fullSpan.durationMs = fullSpan.endTime - fullSpan.startTime;
        fullSpan.output = output;
        fullSpan.status = error ? 'error' : 'ok';
        if (error) fullSpan.error = error;
      },
    };
  }

  /** Get all runs (most recent first). */
  async listRuns(limit = 50, sessionId?: string): Promise<TraceRun[]> {
    const all = await getStorage().list<TraceRun>('traces');
    let filtered = all;
    if (sessionId) {
      filtered = all.filter((r) => r.sessionId === sessionId);
    }
    return filtered.sort((a, b) => b.startTime - a.startTime).slice(0, limit);
  }

  /** Get one run by id. */
  async getRun(id: string): Promise<TraceRun | undefined> {
    return getStorage().get<TraceRun>('traces', id);
  }

  /** List sessions. */
  async listSessions(limit = 50): Promise<TraceSession[]> {
    const all = await getStorage().list<TraceSession>('sessions');
    return all.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
  }

  /** Get a specific session. */
  async getSession(id: string): Promise<TraceSession | undefined> {
    return getStorage().get<TraceSession>('sessions', id);
  }

  /** Delete a run. */
  async deleteRun(id: string): Promise<void> {
    await getStorage().delete('traces', id);
  }

  /** Delete all runs (clear trace history). */
  async clearAll(): Promise<void> {
    await getStorage().clear('traces');
  }

  /** Update session on first run in a session. */
  private async persistSessionHeader(sessionId: string, userMessage: string): Promise<void> {
    const existing = await getStorage().get<TraceSession>('sessions', sessionId);
    if (existing) return;
    const session: TraceSession = {
      id: sessionId,
      title: userMessage.slice(0, 40) || '新会话',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messageCount: 0,
    };
    await getStorage().put('sessions', session);
  }

  /** Update session mtime + count. */
  private async touchSession(sessionId: string): Promise<void> {
    const existing = await getStorage().get<TraceSession>('sessions', sessionId);
    if (!existing) return;
    existing.updatedAt = Date.now();
    existing.messageCount += 2; // user + assistant
    await getStorage().put('sessions', existing);
  }
}

let instance: TraceLogger | null = null;
export function getTraceLogger(): TraceLogger {
  if (!instance) instance = new TraceLogger();
  return instance;
}
