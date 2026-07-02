// @ziner/runtime — Working Memory
//
// Task-level "scratchpad" memory. Working memory holds intermediate
// reasoning, partial results, and planning notes for the duration of
// a single Run. It is NOT persisted across sessions — think of it as
// the agent's mental scratchpad.
//
// At the end of a run, selected entries can be promoted to long-term
// or episodic memory (e.g. key insights, failed approaches that
// shouldn't be repeated).

import type { MemoryManager } from './memory-manager';

export interface WorkingMemoryEntry {
  /** Stable key within this working memory. */
  key: string;
  /** Free-form value (string or JSON-stringifiable). */
  value: string;
  /** Category tag, e.g. "plan", "insight", "failed-approach". */
  category?: string;
  /** 0-1 importance; higher = more likely to be promoted to long-term. */
  importance?: number;
  /** When this entry was created (epoch ms). */
  createdAt: number;
  /** When this entry was last updated (epoch ms). */
  updatedAt: number;
  /** How many times this entry was read. */
  accessCount: number;
}

export interface PromoteOptions {
  /** Which categories to promote. Default: all. */
  categories?: string[];
  /** Minimum importance to promote. Default 0.6. */
  minImportance?: number;
  /** Max entries to promote. Default 5. */
  maxEntries?: number;
  /** Target memory kind. Default 'long-term'. */
  targetKind?: 'long-term' | 'episodic' | 'semantic';
}

export class WorkingMemory {
  private readonly entries = new Map<string, WorkingMemoryEntry>();
  private readonly runId: string;
  private readonly manager?: MemoryManager;
  private readonly userId?: string;
  private readonly projectId?: string;

  constructor(opts: {
    runId: string;
    manager?: MemoryManager;
    userId?: string;
    projectId?: string;
  }) {
    this.runId = opts.runId;
    this.manager = opts.manager;
    this.userId = opts.userId;
    this.projectId = opts.projectId;
  }

  // ── Write ──────────────────────────────────────────────────────────

  /** Write or overwrite a scratchpad entry. */
  set(key: string, value: string, opts?: { category?: string; importance?: number }): void {
    const now = Date.now();
    const existing = this.entries.get(key);
    this.entries.set(key, {
      key,
      value,
      category: opts?.category ?? existing?.category,
      importance: opts?.importance ?? existing?.importance ?? 0.5,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      accessCount: existing?.accessCount ?? 0,
    });
  }

  /** Append text to an entry (creates if missing). */
  append(key: string, text: string, opts?: { category?: string; importance?: number }): void {
    const existing = this.entries.get(key);
    const newValue = existing ? `${existing.value}\n${text}` : text;
    this.set(key, newValue, opts);
  }

  // ── Read ───────────────────────────────────────────────────────────

  /** Read a single entry. Returns undefined if missing. */
  get(key: string): WorkingMemoryEntry | undefined {
    const entry = this.entries.get(key);
    if (entry) {
      entry.accessCount++;
      entry.updatedAt = Date.now();
    }
    return entry;
  }

  /** Check if an entry exists. */
  has(key: string): boolean {
    return this.entries.has(key);
  }

  /** List all entries, optionally filtered by category. */
  list(category?: string): WorkingMemoryEntry[] {
    const entries = [...this.entries.values()];
    if (category) {
      return entries.filter((e) => e.category === category);
    }
    return entries.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  // ── Delete ─────────────────────────────────────────────────────────

  /** Delete an entry. Returns true if it existed. */
  delete(key: string): boolean {
    return this.entries.delete(key);
  }

  /** Clear all entries. */
  clear(): void {
    this.entries.clear();
  }

  // ── Scratchpad helpers ─────────────────────────────────────────────

  /**
   * The "scratchpad" — a single free-form text area agents can use
   * for chain-of-thought notes. This is syntactic sugar over
   * get/set('scratchpad', ...).
   */
  get scratchpad(): string {
    return this.get('scratchpad')?.value ?? '';
  }

  set scratchpad(value: string) {
    this.set('scratchpad', value, { category: 'scratchpad', importance: 0.3 });
  }

  appendToScratchpad(text: string): void {
    this.append('scratchpad', text, { category: 'scratchpad', importance: 0.3 });
  }

  // ── Size helpers ───────────────────────────────────────────────────

  /** Number of entries. */
  get size(): number {
    return this.entries.size;
  }

  /** Total character count across all entries. */
  get totalChars(): number {
    let total = 0;
    for (const e of this.entries.values()) {
      total += e.key.length + e.value.length;
    }
    return total;
  }

  // ── Promotion ──────────────────────────────────────────────────────

  /**
   * Promote selected entries to long-term (or episodic) memory.
   * Only works if a MemoryManager was provided.
   *
   * Returns the number of entries promoted.
   */
  async promote(opts: PromoteOptions = {}): Promise<number> {
    if (!this.manager) return 0;

    const minImportance = opts.minImportance ?? 0.6;
    const maxEntries = opts.maxEntries ?? 5;
    const targetKind = opts.targetKind ?? 'long-term';

    let candidates = this.list().filter((e) => (e.importance ?? 0.5) >= minImportance);
    if (opts.categories && opts.categories.length > 0) {
      candidates = candidates.filter((e) => e.category && opts.categories!.includes(e.category));
    }

    // Sort by importance desc, then access count desc
    candidates.sort((a, b) => {
      const impDiff = (b.importance ?? 0.5) - (a.importance ?? 0.5);
      if (impDiff !== 0) return impDiff;
      return b.accessCount - a.accessCount;
    });

    const toPromote = candidates.slice(0, maxEntries);
    for (const entry of toPromote) {
      const scope = this.userId ? 'user' : 'project';
      await this.manager.remember(
        entry.value,
        targetKind,
        scope,
        {
          importance: entry.importance,
          payload: {
            source: 'working-memory',
            category: entry.category,
            originalKey: entry.key,
            accessCount: entry.accessCount,
            runId: this.runId,
          },
          userId: this.userId,
          projectId: this.projectId,
          runId: this.runId,
        },
      );
    }

    return toPromote.length;
  }

  // ── Serialization ──────────────────────────────────────────────────

  /** Export all entries as a plain array (for debugging / snapshots). */
  snapshot(): WorkingMemoryEntry[] {
    return [...this.entries.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }
}
