// @z-assistant/runtime — memory manager
//
// High-level memory facade used by agents. Wraps an `IMemoryProvider`
// with convenience methods and sensible defaults for scope/kind.

import type {
  IMemoryProvider,
  MemoryRecord,
  MemoryQuery,
  MemoryHit,
  MemoryKind,
  MemoryScope,
  MemoryListFilter,
  MemoryPurgeFilter,
} from '@z-assistant/contracts';
import { newMemoryId } from './types';

export interface MemoryManagerOptions {
  provider: IMemoryProvider;
  /** Default user id for operations that don't supply one. */
  userId?: string;
  /** Default session id. */
  sessionId?: string;
  /** Default agent name. */
  agentName?: string;
  /** Default project id. */
  projectId?: string;
}

/**
 * High-level memory manager. Agents create one of these at the start of
 * a Run and call `remember` / `recall` naturally. The manager fills in
 * default scope/kind metadata from the constructor options.
 */
export class MemoryManager {
  constructor(private readonly opts: MemoryManagerOptions) {}

  get provider(): IMemoryProvider {
    return this.opts.provider;
  }

  get userId(): string | undefined {
    return this.opts.userId;
  }

  get sessionId(): string | undefined {
    return this.opts.sessionId;
  }

  /** Store a memory record, filling in missing metadata. */
  async remember(
    content: string,
    kind: MemoryKind,
    scope: MemoryScope,
    extras?: Partial<MemoryRecord>,
  ): Promise<MemoryRecord> {
    const rec: MemoryRecord = {
      id: extras?.id ?? newMemoryId(),
      content,
      kind,
      scope,
      userId: extras?.userId ?? this.opts.userId ?? '',
      sessionId: extras?.sessionId ?? (scope === 'session' ? this.opts.sessionId : undefined),
      agentName: extras?.agentName ?? (scope === 'agent' ? this.opts.agentName : undefined),
      projectId: extras?.projectId ?? (scope === 'project' ? this.opts.projectId : undefined),
      runId: extras?.runId,
      payload: extras?.payload,
      vector: extras?.vector,
      importance: extras?.importance ?? 0.5,
      createdAt: extras?.createdAt ?? Date.now(),
      ...extras,
    };
    return this.provider.store(rec);
  }

  /** Recall memories across all kinds/scopes, or constrained by the query. */
  async recall(query: string, q?: Partial<MemoryQuery>): Promise<MemoryHit[]> {
    const base: Partial<MemoryQuery> = {};
    if (this.opts.userId !== undefined) base.userId = this.opts.userId;
    return this.provider.recall({ query, ...base, ...q });
  }

  /** List memories, newest first. */
  async list(filter?: MemoryListFilter): Promise<MemoryRecord[]> {
    const base: Partial<MemoryListFilter> = {};
    if (this.opts.userId !== undefined) base.userId = this.opts.userId;
    return this.provider.list({ ...base, ...filter });
  }

  /** Get a single memory by id. */
  async get(id: string): Promise<MemoryRecord | undefined> {
    return this.provider.get(id);
  }

  /** Delete a single memory by id. */
  async forget(id: string): Promise<boolean> {
    return this.provider.delete(id);
  }

  /** Purge memories matching the filter (userId required). */
  async purge(filter: MemoryPurgeFilter): Promise<number> {
    return this.provider.purge(filter);
  }

  /** Count memories matching the filter. */
  async count(filter?: MemoryListFilter): Promise<number> {
    return this.provider.count(filter);
  }

  /** Close the underlying provider. */
  async close(): Promise<void> {
    return this.provider.close();
  }
}
