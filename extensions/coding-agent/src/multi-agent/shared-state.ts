// SharedState — the multi-Agent blackboard.
//
// Per V2_VISION.md §"Multi-Agent Architecture", all agents share a
// common state to read/write artifacts, plans, and intermediate results.
// One implementation per `TaskContext`.
//
// Semantics:
//   - `set(key, value)` always overwrites; returns a versioned value
//   - `subscribe(key, listener)` notifies when that key changes
//   - All operations are synchronous (callers wrap in async when needed)
//   - Values are deep-cloned on write to prevent aliasing bugs
//   - An `incr` helper supports counter use cases (e.g. retry budget)

import type { SharedState as ISharedState } from '../contracts';

type Listener<T = unknown> = (value: T, version: number) => void;

interface Entry {
  value: unknown;
  version: number;
  updatedAt: number;
  writer?: string;   // last agent that wrote this key
}

export interface SharedStateOptions {
  /** Initial values (e.g. restored from previous Run). */
  initial?: Record<string, unknown>;
}

export class SharedState implements ISharedState {
  private _store = new Map<string, Entry>();
  private _listeners = new Map<string, Set<Listener>>();
  private _anyListeners = new Set<(key: string, value: unknown, version: number) => void>();

  constructor(opts: SharedStateOptions = {}) {
    for (const [k, v] of Object.entries(opts.initial ?? {})) {
      this._store.set(k, { value: deepClone(v), version: 1, updatedAt: Date.now() });
    }
  }

  // ── Read / write ────────────────────────────────────────────────────

  get<T = unknown>(key: string): T | undefined {
    return this._store.get(key)?.value as T | undefined;
  }

  /** True if the key has been set at least once. */
  has(key: string): boolean {
    return this._store.has(key);
  }

  /**
   * Set a value. `writer` is recorded for audit (agent name).
   * Notifies all subscribers synchronously.
   */
  set<T = unknown>(key: string, value: T, writer?: string): void {
    const entry: Entry = {
      value: deepClone(value),
      version: (this._store.get(key)?.version ?? 0) + 1,
      updatedAt: Date.now(),
      writer,
    };
    this._store.set(key, entry);
    this._notify(key, entry.value, entry.version);
  }

  /**
   * Atomic increment. Creates with `by` if missing.
   * Returns the new value.
   */
  incr(key: string, by = 1, writer?: string): number {
    const cur = (this._store.get(key)?.value as number) ?? 0;
    const next = cur + by;
    this.set(key, next, writer);
    return next;
  }

  /** Remove a key (does NOT notify per-key subscribers; "any" subscribers still see it). */
  delete(key: string): boolean {
    const had = this._store.delete(key);
    if (had) {
      for (const fn of this._anyListeners) {
        try { fn(key, undefined, 0); } catch { /* ignore */ }
      }
    }
    return had;
  }

  /** Number of keys currently stored. */
  size(): number {
    return this._store.size;
  }

  /** Snapshot of all keys + versions, for persistence. */
  snapshot(): Record<string, { value: unknown; version: number; updatedAt: number; writer?: string }> {
    const out: Record<string, { value: unknown; version: number; updatedAt: number; writer?: string }> = {};
    for (const [k, e] of this._store) {
      out[k] = { value: deepClone(e.value), version: e.version, updatedAt: e.updatedAt, writer: e.writer };
    }
    return out;
  }

  // ── Subscriptions ───────────────────────────────────────────────────

  /**
   * Subscribe to changes on a specific key. The listener is called
   * synchronously on every `set()` for that key.
   * Returns an unsubscribe function.
   */
  subscribe<T = unknown>(key: string, listener: (value: T, version: number) => void): () => void {
    let set = this._listeners.get(key);
    if (!set) {
      set = new Set();
      this._listeners.set(key, set);
    }
    set.add(listener as Listener);
    return () => {
      set!.delete(listener as Listener);
      if (set!.size === 0) this._listeners.delete(key);
    };
  }

  /** Subscribe to all changes. */
  subscribeAny(listener: (key: string, value: unknown, version: number) => void): () => void {
    this._anyListeners.add(listener);
    return () => { this._anyListeners.delete(listener); };
  }

  // ── Internals ───────────────────────────────────────────────────────

  private _notify(key: string, value: unknown, version: number): void {
    const set = this._listeners.get(key);
    if (set) {
      for (const fn of set) {
        try { fn(value, version); } catch (e) {
          // Don't let one bad listener block others.
          // eslint-disable-next-line no-console
          console.error(`[SharedState] listener for '${key}' threw:`, e);
        }
      }
    }
    for (const fn of this._anyListeners) {
      try { fn(key, value, version); } catch (e) {
        // eslint-disable-next-line no-console
        console.error('[SharedState] any-listener threw:', e);
      }
    }
  }
}

function deepClone<T>(v: T): T {
  if (v === null || v === undefined) return v;
  if (typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(deepClone) as unknown as T;
  if (v instanceof Date) return new Date(v.getTime()) as unknown as T;
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    out[k] = deepClone(val);
  }
  return out as T;
}
