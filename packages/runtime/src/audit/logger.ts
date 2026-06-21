// @z-assistant/runtime — Audit Logger (P1-2 HITL).
//
// Appends AuditLogEntry records to `<rootDir>/audit.jsonl` so the user
// can review everything the Agent did after the fact. Entries are
// written at two points in a tool call's lifecycle:
//
//   1. When a confirmation decision is made (outcome = 'pending' or 'blocked')
//   2. After the tool executes (outcome = 'success' or 'error')
//
// The logger is append-only and uses a serialized write chain (same
// pattern as RunTracker) so concurrent writes never interleave.
//
// If no `rootDir` is provided, the logger is a no-op — useful for tests
// and headless mode where disk persistence isn't needed.

import { promises as fsp, existsSync, mkdirSync, createReadStream } from 'fs';
import { join, dirname } from 'path';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import type { AuditLogEntry, Decision, RiskLevel } from '@z-assistant/contracts';

// ── Options ──────────────────────────────────────────────────────────

export interface AuditLoggerOptions {
  /**
   * Root directory for `audit.jsonl`. Created if missing.
   * If omitted, the logger is a no-op (in-memory only).
   */
  rootDir?: string;
  /** Filename; default 'audit.jsonl'. */
  filename?: string;
  /**
   * Max entries to keep in memory for `list()` when no rootDir is set,
   * or as a read cache. Default 1000.
   */
  maxInMemory?: number;
}

// ── Filter for list() ────────────────────────────────────────────────

export interface AuditListFilter {
  runId?: string;
  userId?: string;
  toolName?: string;
  outcome?: AuditLogEntry['outcome'];
  risk?: RiskLevel;
  /** Inclusive lower bound (epoch ms). */
  since?: number;
  /** Inclusive upper bound (epoch ms). */
  until?: number;
  /** Max entries to return; default 100. */
  limit?: number;
}

// ── Helpers (same pattern as JsonlMemoryProvider / jsonl-store) ──────

function ensureDir(p: string): void {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

async function atomicAppend(file: string, line: string): Promise<void> {
  ensureDir(dirname(file));
  await fsp.appendFile(file, line + '\n', 'utf8');
}

// ── AuditLogger ──────────────────────────────────────────────────────

/**
 * Append-only audit logger backed by a JSONL file.
 *
 * Usage:
 *   const logger = new AuditLogger({ rootDir: '/path/to/storage' });
 *   await logger.logPending({ runId, invocationId, toolName, args, risk, decision, userId });
 *   // ... tool executes ...
 *   await logger.logOutcome({ invocationId, outcome: 'success', durationMs: 42 });
 *   const recent = await logger.list({ runId, limit: 50 });
 */
export class AuditLogger {
  private readonly rootDir?: string;
  private readonly filename: string;
  private readonly filePath?: string;
  private readonly maxInMemory: number;
  private readonly buffer: AuditLogEntry[] = [];
  /** Serialized write chain — each write awaits the previous. */
  private writeChain: Promise<void> = Promise.resolve();

  constructor(opts: AuditLoggerOptions = {}) {
    this.rootDir = opts.rootDir;
    this.filename = opts.filename ?? 'audit.jsonl';
    this.maxInMemory = opts.maxInMemory ?? 1000;
    if (this.rootDir) {
      this.filePath = join(this.rootDir, this.filename);
    }
  }

  /** The file path, or undefined if running in no-op mode. */
  get path(): string | undefined {
    return this.filePath;
  }

  // ── Write methods ────────────────────────────────────────────────

  /**
   * Append a full AuditLogEntry. Auto-fills `id` and `timestamp` if missing.
   * Returns the written entry.
   */
  log(partial: Partial<AuditLogEntry> & Pick<AuditLogEntry, 'invocationId' | 'toolName' | 'args' | 'risk' | 'outcome'>): Promise<AuditLogEntry> {
    const entry: AuditLogEntry = {
      id: partial.id ?? randomUUID(),
      timestamp: partial.timestamp ?? Date.now(),
      runId: partial.runId,
      invocationId: partial.invocationId,
      toolName: partial.toolName,
      args: partial.args,
      risk: partial.risk,
      decision: partial.decision,
      matchedRuleId: partial.matchedRuleId,
      outcome: partial.outcome,
      errorMessage: partial.errorMessage,
      durationMs: partial.durationMs,
      userId: partial.userId,
    };
    return this.appendEntry(entry);
  }

  /**
   * Convenience: log at decision time (outcome = 'pending' or 'blocked').
   */
  logPending(params: {
    runId?: string;
    invocationId: string;
    toolName: string;
    args: Record<string, unknown>;
    risk: RiskLevel;
    decision?: Decision;
    matchedRuleId?: string;
    userId?: string;
    blocked?: boolean;
  }): Promise<AuditLogEntry> {
    return this.log({
      runId: params.runId,
      invocationId: params.invocationId,
      toolName: params.toolName,
      args: params.args,
      risk: params.risk,
      decision: params.decision,
      matchedRuleId: params.matchedRuleId,
      outcome: params.blocked ? 'blocked' : 'pending',
      userId: params.userId,
    });
  }

  /**
   * Convenience: log after execution (outcome = 'success' or 'error').
   * Uses the same invocationId so the two entries can be correlated.
   */
  logOutcome(params: {
    runId?: string;
    invocationId: string;
    toolName: string;
    args?: Record<string, unknown>;
    risk: RiskLevel;
    outcome: 'success' | 'error';
    errorMessage?: string;
    durationMs?: number;
    userId?: string;
  }): Promise<AuditLogEntry> {
    return this.log({
      runId: params.runId,
      invocationId: params.invocationId,
      toolName: params.toolName,
      args: params.args ?? {},
      risk: params.risk,
      outcome: params.outcome,
      errorMessage: params.errorMessage,
      durationMs: params.durationMs,
      userId: params.userId,
    });
  }

  /**
   * Await all pending writes. Call before reading state or shutting down.
   */
  async flush(): Promise<void> {
    await this.writeChain;
  }

  // ── Read methods ─────────────────────────────────────────────────

  /**
   * List audit entries matching the filter. Reads from disk (streaming)
   * if a rootDir is set, otherwise from the in-memory buffer.
   */
  async list(filter: AuditListFilter = {}): Promise<AuditLogEntry[]> {
    const limit = filter.limit ?? 100;
    if (this.filePath && existsSync(this.filePath)) {
      return this.listFromDisk(filter, limit);
    }
    return this.listFromBuffer(filter, limit);
  }

  /** Count entries matching the filter (no limit). */
  async count(filter: AuditListFilter = {}): Promise<number> {
    const all = await this.list({ ...filter, limit: Number.MAX_SAFE_INTEGER });
    return all.length;
  }

  // ── Internals ────────────────────────────────────────────────────

  private appendEntry(entry: AuditLogEntry): Promise<AuditLogEntry> {
    // Buffer for in-memory reads.
    this.buffer.push(entry);
    if (this.buffer.length > this.maxInMemory) {
      this.buffer.splice(0, this.buffer.length - this.maxInMemory);
    }

    // Persist to disk (serialized).
    if (this.filePath) {
      this.writeChain = this.writeChain
        .then(() => atomicAppend(this.filePath!, JSON.stringify(entry)))
        .catch((err) => {
          // Don't break the chain on write errors; log to console.
          console.error('[AuditLogger] append error:', err);
        });
    }

    // Return the entry immediately; disk write is fire-and-forget.
    return Promise.resolve(entry);
  }

  private listFromBuffer(filter: AuditListFilter, limit: number): AuditLogEntry[] {
    const out: AuditLogEntry[] = [];
    // Iterate newest-first so limit returns the most recent.
    for (let i = this.buffer.length - 1; i >= 0 && out.length < limit; i--) {
      if (this.matchesFilter(this.buffer[i], filter)) out.push(this.buffer[i]);
    }
    return out;
  }

  private async listFromDisk(filter: AuditListFilter, limit: number): Promise<AuditLogEntry[]> {
    const out: AuditLogEntry[] = [];
    const stream = createReadStream(this.filePath!, { encoding: 'utf8' });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });

    // Collect all matching entries, then take the last `limit`.
    const matched: AuditLogEntry[] = [];
    for await (const line of rl) {
      if (!line) continue;
      try {
        const entry = JSON.parse(line) as AuditLogEntry;
        if (this.matchesFilter(entry, filter)) matched.push(entry);
      } catch {
        // skip malformed
      }
    }
    // Return newest-first.
    const start = Math.max(0, matched.length - limit);
    for (let i = matched.length - 1; i >= start; i--) {
      out.push(matched[i]);
    }
    return out;
  }

  private matchesFilter(entry: AuditLogEntry, f: AuditListFilter): boolean {
    if (f.runId !== undefined && entry.runId !== f.runId) return false;
    if (f.userId !== undefined && entry.userId !== f.userId) return false;
    if (f.toolName !== undefined && entry.toolName !== f.toolName) return false;
    if (f.outcome !== undefined && entry.outcome !== f.outcome) return false;
    if (f.risk !== undefined && entry.risk !== f.risk) return false;
    if (f.since !== undefined && entry.timestamp < f.since) return false;
    if (f.until !== undefined && entry.timestamp > f.until) return false;
    return true;
  }
}

// ── NoopAuditLogger (for tests / disabled mode) ──────────────────────

/**
 * An audit logger that does nothing. Useful as a default when audit
 * logging is disabled or in tests.
 */
export class NoopAuditLogger {
  async log(_partial: Partial<AuditLogEntry> & Pick<AuditLogEntry, 'invocationId' | 'toolName' | 'args' | 'risk' | 'outcome'>): Promise<AuditLogEntry> {
    return {
      id: 'noop',
      timestamp: Date.now(),
      invocationId: _partial.invocationId,
      toolName: _partial.toolName,
      args: _partial.args,
      risk: _partial.risk,
      outcome: _partial.outcome,
    };
  }
  async logPending(_params: any): Promise<AuditLogEntry> {
    return { id: 'noop', timestamp: Date.now(), invocationId: _params.invocationId, toolName: _params.toolName, args: _params.args, risk: _params.risk, outcome: 'pending' };
  }
  async logOutcome(_params: any): Promise<AuditLogEntry> {
    return { id: 'noop', timestamp: Date.now(), invocationId: _params.invocationId, toolName: _params.toolName, args: {}, risk: _params.risk, outcome: _params.outcome };
  }
  async flush(): Promise<void> {}
  async list(_filter?: AuditListFilter): Promise<AuditLogEntry[]> { return []; }
  async count(_filter?: AuditListFilter): Promise<number> { return 0; }
}

/**
 * Union type for any audit logger (real or noop).
 */
export type IAuditLogger = AuditLogger | NoopAuditLogger;
