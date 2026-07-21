import { randomUUID } from 'crypto';
import type { AgentRun, AgentSpan, ModelRef, RunStatus } from '@ziner/contracts';
import { computeDuration } from '@ziner/contracts';
import type { ITraceStore, TraceRunDetail, TraceRunSummary, TraceSessionSummary } from '@ziner/runtime-core';
import { createFileStore, type Store } from '@ziner/infra-storage';

export interface FileTraceStoreOptions {
  rootDir: string;
}

export class FileTraceStore implements ITraceStore {
  private storePromise: Promise<Store>;

  constructor(options: FileTraceStoreOptions) {
    this.storePromise = createFileStore({ rootDir: options.rootDir });
  }

  private async store(): Promise<Store> {
    return this.storePromise;
  }

  async startRun(task: string, sessionId: string, model: string): Promise<AgentRun> {
    const now = Date.now();
    const run: AgentRun = {
      id: randomUUID(),
      traceId: this.createTraceId(),
      sessionId,
      task,
      model: this.parseModel(model),
      startTime: now,
      status: 'running',
      totalTokensIn: 0,
      totalTokensOut: 0,
      totalCostUsd: 0,
      tags: [],
      metadata: {},
    };
    await (await this.store()).runs.insert(run);
    return run;
  }

  async endRun(runId: string, status: Exclude<RunStatus, 'running'>): Promise<void> {
    const store = await this.store();
    const run = await store.runs.get(runId);
    if (!run) return;
    const endTime = Date.now();
    await store.runs.update(runId, {
      endTime,
      duration: computeDuration(run.startTime, endTime),
      status,
    });
  }

  async recordSpan(
    runId: string,
    span: Omit<AgentSpan, 'id' | 'runId' | 'traceId'> & Partial<Pick<AgentSpan, 'id' | 'traceId'>>,
  ): Promise<AgentSpan> {
    const store = await this.store();
    const run = await store.runs.get(runId);
    const fullSpan: AgentSpan = {
      ...span,
      id: span.id ?? randomUUID(),
      runId,
      traceId: span.traceId ?? run?.traceId ?? this.createTraceId(),
      attributes: span.attributes ?? {},
      events: span.events ?? [],
    };
    await store.spans.insert(fullSpan);
    return fullSpan;
  }

  async listRuns(limit = 50, sessionId?: string): Promise<TraceRunSummary[]> {
    const store = await this.store();
    const runs = await store.runs.list({ limit, sessionId, order: 'desc' });
    return Promise.all(runs.map((run) => this.toRunSummary(run)));
  }

  async getRun(id: string): Promise<TraceRunDetail | undefined> {
    const store = await this.store();
    const run = await store.runs.get(id);
    if (!run) return undefined;
    const spans = await store.spans.listByRun(id, { order: 'asc' });
    return {
      ...(await this.toRunSummary(run, spans)),
      endTime: run.endTime,
      spans,
      error: run.error?.message,
    };
  }

  async listSessions(limit = 50): Promise<TraceSessionSummary[]> {
    const store = await this.store();
    const runs = await store.runs.list({ limit: 1000, order: 'desc' });
    const sessions = new Map<string, TraceSessionSummary>();
    for (const run of runs) {
      const existing = sessions.get(run.sessionId);
      if (existing) {
        existing.updatedAt = Math.max(existing.updatedAt, run.endTime ?? run.startTime);
        existing.createdAt = Math.min(existing.createdAt, run.startTime);
        existing.messageCount += 1;
      } else {
        sessions.set(run.sessionId, {
          id: run.sessionId,
          title: run.task.slice(0, 60) || run.sessionId,
          createdAt: run.startTime,
          updatedAt: run.endTime ?? run.startTime,
          messageCount: 1,
        });
      }
    }
    return [...sessions.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit);
  }

  async deleteRun(id: string): Promise<void> {
    const store = await this.store();
    await store.spans.deleteByRun(id);
    await store.runs.delete(id);
  }

  async clear(): Promise<void> {
    const store = await this.store();
    const runs = await store.runs.list({ limit: 100000, order: 'desc' });
    await Promise.all(runs.map((run) => this.deleteRun(run.id)));
  }

  async close(): Promise<void> {
    await (await this.store()).close();
  }

  private async toRunSummary(run: AgentRun, providedSpans?: AgentSpan[]): Promise<TraceRunSummary> {
    const spans = providedSpans ?? await (await this.store()).spans.listByRun(run.id);
    const llmCalls = spans.filter((span) => span.type === 'llm').length;
    const toolCalls = spans.filter((span) => span.type === 'tool').length;
    return {
      id: run.id,
      sessionId: run.sessionId,
      userMessage: run.task,
      startTime: run.startTime,
      durationMs: run.duration,
      status: run.status,
      llmCalls,
      toolCalls,
      totalTokens: run.totalTokensIn + run.totalTokensOut,
      totalCostUsd: run.totalCostUsd,
      skills: run.tags.filter((tag) => tag.startsWith('skill:')).map((tag) => tag.slice('skill:'.length)),
      mcpServers: run.tags.filter((tag) => tag.startsWith('mcp:')).map((tag) => tag.slice('mcp:'.length)),
    };
  }

  private parseModel(model: string): ModelRef {
    const slash = model.indexOf('/');
    if (slash > 0) {
      return { provider: model.slice(0, slash), name: model.slice(slash + 1) || 'default' };
    }
    return { provider: 'default', name: model || 'default' };
  }

  private createTraceId(): string {
    return randomUUID().replace(/-/g, '').slice(0, 32);
  }
}
