// @z-assistant/runtime — memory shared types/helpers
//
// Internal utilities used by the memory subsystems. These are not exported
// from the package root; consumers use the typed managers and the provider
// interface instead.

import type { MemoryKind, MemoryScope, MemoryRecord, MemoryListFilter, MemoryPurgeFilter } from '@z-assistant/contracts';

/** Create a ULID-like time-sortable id without extra dependencies. */
export function newMemoryId(): string {
  const time = Date.now().toString(36).padStart(8, '0');
  const rand = Math.random().toString(36).slice(2, 12);
  return `${time}-${rand}`;
}

export function normalizeKinds(kind?: MemoryKind | MemoryKind[]): MemoryKind[] | undefined {
  if (!kind) return undefined;
  return Array.isArray(kind) ? kind : [kind];
}

export function normalizeScopes(scope?: MemoryScope | MemoryScope[]): MemoryScope[] | undefined {
  if (!scope) return undefined;
  return Array.isArray(scope) ? scope : [scope];
}

export function matchMemoryRecord(r: MemoryRecord, filter: MemoryListFilter): boolean {
  if (filter.kind) {
    const kinds = Array.isArray(filter.kind) ? filter.kind : [filter.kind];
    if (!kinds.includes(r.kind)) return false;
  }
  if (filter.scope) {
    const scopes = Array.isArray(filter.scope) ? filter.scope : [filter.scope];
    if (!scopes.includes(r.scope)) return false;
  }
  if (filter.userId !== undefined && r.userId !== filter.userId) return false;
  if (filter.sessionId !== undefined && r.sessionId !== filter.sessionId) return false;
  if (filter.agentName !== undefined && r.agentName !== filter.agentName) return false;
  if (filter.projectId !== undefined && r.projectId !== filter.projectId) return false;
  if (filter.runId !== undefined && r.runId !== filter.runId) return false;
  if (!filter.includeDeleted && r.deleted) return false;
  return true;
}

export function matchPurgeFilter(r: MemoryRecord, filter: MemoryPurgeFilter): boolean {
  if (r.deleted) return false;
  if (r.userId !== filter.userId) return false;
  if (filter.kind) {
    const kinds = Array.isArray(filter.kind) ? filter.kind : [filter.kind];
    if (!kinds.includes(r.kind)) return false;
  }
  if (filter.scope) {
    const scopes = Array.isArray(filter.scope) ? filter.scope : [filter.scope];
    if (!scopes.includes(r.scope)) return false;
  }
  if (filter.sessionId !== undefined && r.sessionId !== filter.sessionId) return false;
  if (filter.agentName !== undefined && r.agentName !== filter.agentName) return false;
  if (filter.projectId !== undefined && r.projectId !== filter.projectId) return false;
  if (filter.before !== undefined && r.createdAt >= filter.before) return false;
  return true;
}

/** Score how well a record matches a text query using simple keyword overlap. */
export function keywordScore(query: string, content: string): number;
export function keywordScore(query: string, contentTokens: Set<string>): number;
export function keywordScore(query: string, content: string | Set<string>): number {
  const q = query.toLowerCase().split(/\W+/).filter(Boolean);
  if (q.length === 0) return 0;
  const c = content instanceof Set ? content : new Set(content.toLowerCase().split(/\W+/).filter(Boolean));
  if (c.size === 0) return 0;
  let matches = 0;
  for (const word of q) {
    if (c.has(word)) matches++;
  }
  return matches / Math.max(q.length, c.size);
}
