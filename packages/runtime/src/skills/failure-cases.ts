// @ziner/runtime — Failure Case Store (P1-3 Skill Auto-Discovery).
//
// Append-only JSONL persistence for FailureCase records. Used by the
// auto-discovery pipeline to cluster recurring failures into proposed
// CandidateSkills.
//
// Mirrors the AuditLogger pattern:
//   - sync mkdir for the root dir on construction
//   - serialized write chain to prevent interleaved JSONL lines
//   - whole-file scan on read (fine for our workload — failure cases
//     are bounded by retention policy upstream)
//
// The Noop variant satisfies the same interface but persists nothing;
// useful for tests, headless mode, or when auto-discovery is disabled.

import { promises as fsp, existsSync, mkdirSync, createReadStream } from 'fs';
import { join } from 'path';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import type {
  FailureCase,
  FailureCaseQuery,
  FailureGroup,
  IFailureCaseStore,
  AgentRun,
  AgentSpan,
} from '@ziner/contracts';
import { normalizePattern } from '../evolution/evolution';

// ── Options ──────────────────────────────────────────────────────────

export interface JsonlFailureCaseStoreOptions {
  /** Root directory for `failure-cases.jsonl`. Created if missing. */
  rootDir: string;
  /** Filename; default 'failure-cases.jsonl'. */
  filename?: string;
}

// ── JsonlFailureCaseStore ────────────────────────────────────────────

export class JsonlFailureCaseStore implements IFailureCaseStore {
  private readonly filePath: string;
  /** Serialized write chain — each append awaits the previous. */
  private writeChain: Promise<void> = Promise.resolve();
  private cache?: FailureCase[];
  private cacheMtime = 0;
  private cacheSize = 0;

  constructor(opts: JsonlFailureCaseStoreOptions) {
    if (!existsSync(opts.rootDir)) mkdirSync(opts.rootDir, { recursive: true });
    this.filePath = join(opts.rootDir, opts.filename ?? 'failure-cases.jsonl');
  }

  /** The persisted file path. */
  get path(): string {
    return this.filePath;
  }

  /** Await all pending writes. */
  async flush(): Promise<void> {
    await this.writeChain;
  }

  // ── IFailureCaseStore ───────────────────────────────────────────

  record(fc: FailureCase): Promise<void> {
    const entry: FailureCase = { ...fc, id: fc.id || randomUUID() };
    const line = JSON.stringify(entry) + '\n';
    this.writeChain = this.writeChain
      .then(() => fsp.appendFile(this.filePath, line, 'utf8'))
      .catch((err) => {
        console.error('[JsonlFailureCaseStore] append error:', err);
      })
      .finally(() => {
        this.cache = undefined;
      });
    return this.writeChain;
  }

  async list(q: FailureCaseQuery = {}): Promise<FailureCase[]> {
    const all = await this.readAll();
    const filtered = all.filter((fc) => matchesQuery(fc, q));
    filtered.sort((a, b) => b.timestamp - a.timestamp);
    if (q.limit !== undefined) return filtered.slice(0, Math.max(0, q.limit));
    return filtered;
  }

  async count(q: FailureCaseQuery = {}): Promise<number> {
    await this.writeChain;
    if (!existsSync(this.filePath)) return 0;
    const stream = createReadStream(this.filePath, { encoding: 'utf8' });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    let n = 0;
    for await (const line of rl) {
      if (!line) continue;
      try {
        const fc = JSON.parse(line) as FailureCase;
        if (matchesQuery(fc, q)) n++;
      } catch {
        // skip malformed
      }
    }
    return n;
  }

  async group(q: FailureCaseQuery = {}): Promise<FailureGroup[]> {
    const cases = await this.list({ ...q, limit: undefined });
    const groups = new Map<string, FailureGroup>();
    for (const fc of cases) {
      const key = `${fc.agent}|${fc.errorCode}|${fc.errorPattern}`;
      let g = groups.get(key);
      if (!g) {
        g = {
          key,
          agent: fc.agent,
          errorCode: fc.errorCode,
          errorPattern: fc.errorPattern,
          cases: [],
          firstSeen: fc.timestamp,
          lastSeen: fc.timestamp,
          toolNames: [],
        };
        groups.set(key, g);
      }
      g.cases.push(fc);
      if (fc.timestamp < g.firstSeen) g.firstSeen = fc.timestamp;
      if (fc.timestamp > g.lastSeen) g.lastSeen = fc.timestamp;
      if (fc.toolName && !g.toolNames.includes(fc.toolName)) {
        g.toolNames.push(fc.toolName);
      }
    }
    return [...groups.values()].sort((a, b) => b.cases.length - a.cases.length);
  }

  // ── Internals ───────────────────────────────────────────────────

  private async readAll(): Promise<FailureCase[]> {
    await this.writeChain;
    if (!existsSync(this.filePath)) return [];
    const stat = await fsp.stat(this.filePath);
    if (this.cache && this.cacheMtime === stat.mtimeMs && this.cacheSize === stat.size) {
      return this.cache;
    }
    const raw = await fsp.readFile(this.filePath, 'utf8');
    const out: FailureCase[] = [];
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as FailureCase);
      } catch {
        // skip malformed
      }
    }
    this.cache = out;
    this.cacheMtime = stat.mtimeMs;
    this.cacheSize = stat.size;
    return out;
  }
}

/** Factory helper. */
export function createJsonlFailureCaseStore(
  opts: JsonlFailureCaseStoreOptions
): JsonlFailureCaseStore {
  return new JsonlFailureCaseStore(opts);
}

// ── NoopFailureCaseStore ─────────────────────────────────────────────

/** No-op store. Useful when auto-discovery is disabled. */
export class NoopFailureCaseStore implements IFailureCaseStore {
  async record(_fc: FailureCase): Promise<void> {
    // no-op
  }
  async list(_q?: FailureCaseQuery): Promise<FailureCase[]> {
    return [];
  }
  async count(_q?: FailureCaseQuery): Promise<number> {
    return 0;
  }
  async group(_q?: FailureCaseQuery): Promise<FailureGroup[]> {
    return [];
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

function matchesQuery(fc: FailureCase, q: FailureCaseQuery): boolean {
  if (q.agent !== undefined && fc.agent !== q.agent) return false;
  if (q.errorCode !== undefined && fc.errorCode !== q.errorCode) return false;
  if (q.errorPattern !== undefined && fc.errorPattern !== q.errorPattern) return false;
  if (q.toolName !== undefined && fc.toolName !== q.toolName) return false;
  if (q.fromTs !== undefined && fc.timestamp < q.fromTs) return false;
  if (q.toTs !== undefined && fc.timestamp > q.toTs) return false;
  return true;
}

/**
 * Convert a failed AgentRun's spans into FailureCase records.
 * Mirrors `fingerprintRun` from evolution.ts but produces the richer
 * FailureCase shape used by the auto-discovery pipeline.
 */
export function failureCaseFromRun(
  run: AgentRun,
  spans: readonly AgentSpan[]
): FailureCase[] {
  const out: FailureCase[] = [];
  for (const s of spans) {
    if (s.status !== 'error' || !s.error) continue;
    const msg = s.error.message ?? '';
    const toolName = extractToolName(s);
    out.push({
      id: randomUUID(),
      timestamp: s.startTime,
      runId: run.id,
      agent: s.name,
      task: run.task.slice(0, 200),
      errorCode: s.error.code,
      errorMessage: msg.slice(0, 200),
      errorPattern: normalizePattern(msg),
      toolName,
    });
  }
  return out;
}

function extractToolName(s: AgentSpan): string | undefined {
  if (s.type === 'tool') {
    const attr = s.attributes?.['tool.name'];
    if (typeof attr === 'string') return attr;
    // Fall back to the span name suffix (e.g. "tool:edit_file").
    const idx = s.name.indexOf(':');
    if (idx >= 0) return s.name.slice(idx + 1);
  }
  return undefined;
}
