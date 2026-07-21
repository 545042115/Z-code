import type { SharedState as ISharedState } from '@ziner/contracts';

export type SharedStateListener<T = unknown> = (value: T, version: number) => void;

interface Entry {
  value: unknown;
  version: number;
  updatedAt: number;
  writer?: string;
}

export interface SharedStateOptions {
  initial?: Record<string, unknown>;
}

export class SharedState implements ISharedState {
  private store = new Map<string, Entry>();
  private listeners = new Map<string, Set<SharedStateListener>>();
  private anyListeners = new Set<(key: string, value: unknown, version: number) => void>();

  constructor(options: SharedStateOptions = {}) {
    for (const [key, value] of Object.entries(options.initial ?? {})) {
      this.store.set(key, { value: deepClone(value), version: 1, updatedAt: Date.now() });
    }
  }

  get<T = unknown>(key: string): T | undefined {
    return this.store.get(key)?.value as T | undefined;
  }

  has(key: string): boolean {
    return this.store.has(key);
  }

  set<T = unknown>(key: string, value: T, writer?: string): void {
    const entry: Entry = {
      value: deepClone(value),
      version: (this.store.get(key)?.version ?? 0) + 1,
      updatedAt: Date.now(),
      writer,
    };
    this.store.set(key, entry);
    this.notify(key, entry.value, entry.version);
  }

  incr(key: string, by = 1, writer?: string): number {
    const current = (this.store.get(key)?.value as number) ?? 0;
    const next = current + by;
    this.set(key, next, writer);
    return next;
  }

  delete(key: string): boolean {
    const had = this.store.delete(key);
    if (had) {
      for (const listener of this.anyListeners) {
        try { listener(key, undefined, 0); } catch {}
      }
    }
    return had;
  }

  size(): number {
    return this.store.size;
  }

  snapshot(): Record<string, { value: unknown; version: number; updatedAt: number; writer?: string }> {
    const out: Record<string, { value: unknown; version: number; updatedAt: number; writer?: string }> = {};
    for (const [key, entry] of this.store) {
      out[key] = { value: deepClone(entry.value), version: entry.version, updatedAt: entry.updatedAt, writer: entry.writer };
    }
    return out;
  }

  subscribe<T = unknown>(key: string, listener: (value: T, version: number) => void): () => void {
    let set = this.listeners.get(key);
    if (!set) {
      set = new Set();
      this.listeners.set(key, set);
    }
    set.add(listener as SharedStateListener);
    return () => {
      set?.delete(listener as SharedStateListener);
      if (set?.size === 0) this.listeners.delete(key);
    };
  }

  subscribeAny(listener: (key: string, value: unknown, version: number) => void): () => void {
    this.anyListeners.add(listener);
    return () => { this.anyListeners.delete(listener); };
  }

  private notify(key: string, value: unknown, version: number): void {
    const set = this.listeners.get(key);
    if (set) {
      for (const listener of set) {
        try { listener(value, version); } catch (error) {
          console.error(`[SharedState] listener for '${key}' threw:`, error);
        }
      }
    }
    for (const listener of this.anyListeners) {
      try { listener(key, value, version); } catch (error) {
        console.error('[SharedState] any-listener threw:', error);
      }
    }
  }
}

function deepClone<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(deepClone) as unknown as T;
  if (value instanceof Date) return new Date(value.getTime()) as unknown as T;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    out[key] = deepClone(entry);
  }
  return out as T;
}
