// FileStore — the Phase 0 default storage backend.
//
// Layout under `rootDir`:
//
//   <rootDir>/
//     runs.jsonl           # one AgentRun per line, append-only
//     spans.jsonl          # one AgentSpan per line, append-only
//     evaluations.jsonl    # one Evaluation per line, append-only
//     benchmarks.json      # JSON array (rarely changes, read-mostly)
//     traces/<runId>.jsonl # SpanEvent stream per Run
//     .index/              # (reserved for future secondary indexes)
//
// Semantics:
//   - `insert` APPENDS to the log; duplicate ids are rejected at read time
//     (later records override earlier ones for the same id).
//   - `update` is implemented as another append with the same id.
//   - `delete` is implemented by appending a tombstone record.
//   - Reads scan the log and build an in-memory index (Map<id, latest>).
//   - Writes use atomic rename (write temp → fsync → rename) for crash safety.
//
// Why JSONL and not SQLite for Phase 0:
//   - Zero new dependencies (extension stays simple to package).
//   - JSONL is genuinely a better fit for trace streams (append-only).
//   - The Store interface is unchanged, so swapping to better-sqlite3
//     in Phase 1+ is a one-file change.

import { promises as fsp, existsSync, mkdirSync, createReadStream } from 'fs';
import { join, dirname } from 'path';
import { createInterface } from 'readline';
import type {
  AgentRun,
  AgentSpan,
  SpanEvent,
  Benchmark,
  Evaluation,
  Baseline,
  PromptCandidate,
  RunStatus,
  SpanStatus,
} from '@ziner/contracts';
import type {
  BaselineQuery,
  BaselineRepo,
  BenchmarkQuery,
  BenchmarkRepo,
  EvalQuery,
  EvalRepo,
  ListQuery,
  PromptCandidateQuery,
  PromptCandidateRepo,
  RunQuery,
  RunRepo,
  SpanQuery,
  SpanRepo,
  Store,
} from './types';

// ── File-level helpers ────────────────────────────────────────────────

async function ensureDir(p: string): Promise<void> {
  if (!existsSync(p)) await fsp.mkdir(p, { recursive: true });
}

async function atomicAppend(file: string, line: string): Promise<void> {
  await ensureDir(dirname(file));
  // Append mode gives us O(1) writes; atomicity is per-line on most OSes.
  // For strict crash safety, a write-temp + rename pattern would be used.
  await fsp.appendFile(file, line + '\n', 'utf8');
}

async function readJsonl<T>(file: string): Promise<T[]> {
  if (!existsSync(file)) return [];
  const text = await fsp.readFile(file, 'utf8');
  if (!text) return [];
  const out: T[] = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // Skip malformed lines (corrupt/partial writes). Logging is the
      // caller's job; we never throw on a bad line.
    }
  }
  return out;
}

// ── Internal record envelopes ─────────────────────────────────────────

type RunRecord = AgentRun | { __deleted: true; id: string };
type SpanRecord = AgentSpan | { __deleted: true; id: string; runId: string };
type EvalRecord = Evaluation;

// ── In-memory cache layer ────────────────────────────────────────────
//
// Caches the parsed JSONL content in memory after the first read.
// Invalidated on any write (insert/update/delete).
// This avoids re-reading the entire file on every query.

class CachedJsonl<T extends { id: string }> {
  private cache: T[] | null = null;
  private loadPromise: Promise<T[]> | null = null;

  constructor(private readonly file: string) {}

  async getAll(): Promise<T[]> {
    if (this.cache !== null) return this.cache;
    if (this.loadPromise) return this.loadPromise;
    this.loadPromise = readJsonl<T>(this.file).then((data) => {
      this.cache = data;
      this.loadPromise = null;
      return data;
    });
    return this.loadPromise;
  }

  invalidate(): void {
    this.cache = null;
  }
}

// ── Repo implementations ──────────────────────────────────────────────

class FileRunRepo implements RunRepo {
  private cache: CachedJsonl<RunRecord>;

  constructor(private readonly file: string) {
    this.cache = new CachedJsonl<RunRecord>(file);
  }

  async insert(run: AgentRun): Promise<void> {
    await atomicAppend(this.file, JSON.stringify(run));
    this.cache.invalidate();
  }

  async get(id: string): Promise<AgentRun | undefined> {
    const all = await this.cache.getAll();
    const latest = pickLatest(all, id);
    return latest && !isTombstone(latest) ? latest : undefined;
  }

  async update(id: string, set: Partial<AgentRun>): Promise<void> {
    const cur = await this.get(id);
    if (!cur) throw new Error(`Run not found: ${id}`);
    await atomicAppend(this.file, JSON.stringify({ ...cur, ...set }));
    this.cache.invalidate();
  }

  async list(q: RunQuery = {}): Promise<AgentRun[]> {
    const all = await this.cache.getAll();
    const map = collapse(all);
    const filtered = [...map.values()].filter(notTombstone).filter((r) => matchRun(r, q));
    return sortAndPaginate(filtered, q, (r) => r.startTime);
  }

  async count(q: RunQuery = {}): Promise<number> {
    return (await this.list({ ...q, limit: undefined, offset: undefined })).length;
  }

  async delete(id: string): Promise<void> {
    await atomicAppend(this.file, JSON.stringify({ __deleted: true, id }));
    this.cache.invalidate();
  }
}

class FileSpanRepo implements SpanRepo {
  private cache: CachedJsonl<SpanRecord>;

  constructor(
    private readonly file: string,
    private readonly runFile: string,
  ) {
    this.cache = new CachedJsonl<SpanRecord>(file);
  }

  async insert(span: AgentSpan): Promise<void> {
    await atomicAppend(this.file, JSON.stringify(span));
    this.cache.invalidate();
  }

  async get(id: string): Promise<AgentSpan | undefined> {
    const all = await this.cache.getAll();
    const latest = pickLatest(all, id);
    return latest && !isSpanTombstone(latest) ? latest : undefined;
  }

  async update(id: string, set: Partial<AgentSpan>): Promise<void> {
    const cur = await this.get(id);
    if (!cur) throw new Error(`Span not found: ${id}`);
    await atomicAppend(this.file, JSON.stringify({ ...cur, ...set }));
    this.cache.invalidate();
  }

  async listByRun(runId: string, q: Omit<SpanQuery, 'runId'> = {}): Promise<AgentSpan[]> {
    return this.list({ ...q, runId });
  }

  async list(q: SpanQuery = {}): Promise<AgentSpan[]> {
    const all = await this.cache.getAll();
    const map = collapse(all);
    const filtered = [...map.values()].filter(notSpanTombstone).filter((s) => matchSpan(s, q));
    return sortAndPaginate(filtered, q, (s) => s.startTime);
  }

  async count(q: SpanQuery = {}): Promise<number> {
    return (await this.list({ ...q, limit: undefined, offset: undefined })).length;
  }

  async deleteByRun(runId: string): Promise<number> {
    const all = await this.cache.getAll();
    const targets = all.filter(notSpanTombstone).filter((s) => s.runId === runId) as AgentSpan[];
    for (const t of targets) {
      await atomicAppend(this.file, JSON.stringify({ __deleted: true, id: t.id, runId }));
    }
    this.cache.invalidate();
    return targets.length;
  }
}

class FileEvalRepo implements EvalRepo {
  constructor(private readonly file: string) {}

  async insert(ev: Evaluation): Promise<void> {
    await atomicAppend(this.file, JSON.stringify(ev));
  }

  async get(id: string): Promise<Evaluation | undefined> {
    const all = await readJsonl<Evaluation>(this.file);
    return all.find((e) => e.id === id);
  }

  async list(q: EvalQuery = {}): Promise<Evaluation[]> {
    const all = await readJsonl<Evaluation>(this.file);
    const filtered = all.filter((e) => matchEval(e, q));
    return sortAndPaginate(filtered, q, (e) => e.timestamp);
  }

  async count(q: EvalQuery = {}): Promise<number> {
    return (await this.list({ ...q, limit: undefined, offset: undefined })).length;
  }

  async passRate(q: EvalQuery = {}): Promise<number> {
    const list = await this.list({ ...q, limit: undefined, offset: undefined });
    if (list.length === 0) return 0;
    const passed = list.filter((e) => e.pass).length;
    return passed / list.length;
  }
}

class FileBenchmarkRepo implements BenchmarkRepo {
  constructor(private readonly file: string) {}

  private async readAll(): Promise<Benchmark[]> {
    if (!existsSync(this.file)) return [];
    try {
      const text = await fsp.readFile(this.file, 'utf8');
      return text ? (JSON.parse(text) as Benchmark[]) : [];
    } catch {
      return [];
    }
  }

  private async writeAll(list: Benchmark[]): Promise<void> {
    await ensureDir(dirname(this.file));
    await fsp.writeFile(this.file, JSON.stringify(list, null, 2), 'utf8');
  }

  async insert(b: Benchmark): Promise<void> {
    const all = await this.readAll();
    if (all.some((x) => x.id === b.id)) {
      throw new Error(`Benchmark already exists: ${b.id}`);
    }
    all.push(b);
    await this.writeAll(all);
  }

  async upsert(b: Benchmark): Promise<void> {
    const all = await this.readAll();
    const idx = all.findIndex((x) => x.id === b.id);
    if (idx >= 0) all[idx] = b;
    else all.push(b);
    await this.writeAll(all);
  }

  async get(id: string): Promise<Benchmark | undefined> {
    const all = await this.readAll();
    return all.find((b) => b.id === id);
  }

  async list(q: BenchmarkQuery = {}): Promise<Benchmark[]> {
    const all = await this.readAll();
    const filtered = all.filter((b) => matchBenchmark(b, q));
    return sortAndPaginate(filtered, q, () => 0); // benchmarks are unsorted by time
  }

  async count(q: BenchmarkQuery = {}): Promise<number> {
    return (await this.list({ ...q, limit: undefined, offset: undefined })).length;
  }

  async delete(id: string): Promise<void> {
    const all = await this.readAll();
    await this.writeAll(all.filter((b) => b.id !== id));
  }
}

// ── BaselineRepo ─────────────────────────────────────────────────────

class FileBaselineRepo implements BaselineRepo {
  constructor(private readonly file: string) {}

  private async readAll(): Promise<Baseline[]> {
    if (!existsSync(this.file)) return [];
    try {
      const text = await fsp.readFile(this.file, 'utf8');
      return text ? (JSON.parse(text) as Baseline[]) : [];
    } catch {
      return [];
    }
  }

  private async writeAll(list: Baseline[]): Promise<void> {
    await ensureDir(dirname(this.file));
    await fsp.writeFile(this.file, JSON.stringify(list, null, 2), 'utf8');
  }

  async insert(b: Baseline): Promise<void> {
    const all = await this.readAll();
    if (all.some((x) => x.id === b.id)) {
      throw new Error(`Baseline already exists: ${b.id}`);
    }
    all.push(b);
    await this.writeAll(all);
  }

  async upsert(b: Baseline): Promise<void> {
    const all = await this.readAll();
    const idx = all.findIndex((x) => x.id === b.id);
    if (idx >= 0) all[idx] = b;
    else all.push(b);
    await this.writeAll(all);
  }

  async get(id: string): Promise<Baseline | undefined> {
    const all = await this.readAll();
    return all.find((b) => b.id === id);
  }

  async list(q: BaselineQuery = {}): Promise<Baseline[]> {
    const all = await this.readAll();
    const filtered = all.filter((b) => matchBaseline(b, q));
    return sortAndPaginate(filtered, q, (b) => b.createdAt);
  }

  async count(q: BaselineQuery = {}): Promise<number> {
    return (await this.list({ ...q, limit: undefined, offset: undefined })).length;
  }

  async delete(id: string): Promise<void> {
    const all = await this.readAll();
    await this.writeAll(all.filter((b) => b.id !== id));
  }
}

// ── PromptCandidateRepo ─────────────────────────────────────────────

class FilePromptCandidateRepo implements PromptCandidateRepo {
  constructor(private readonly file: string) {}

  private async readAll(): Promise<PromptCandidate[]> {
    if (!existsSync(this.file)) return [];
    try {
      const text = await fsp.readFile(this.file, 'utf8');
      return text ? (JSON.parse(text) as PromptCandidate[]) : [];
    } catch {
      return [];
    }
  }

  private async writeAll(list: PromptCandidate[]): Promise<void> {
    await ensureDir(dirname(this.file));
    await fsp.writeFile(this.file, JSON.stringify(list, null, 2), 'utf8');
  }

  async upsert(c: PromptCandidate): Promise<void> {
    const all = await this.readAll();
    const idx = all.findIndex((x) => x.id === c.id);
    if (idx >= 0) all[idx] = c;
    else all.push(c);
    await this.writeAll(all);
  }

  async get(id: string): Promise<PromptCandidate | undefined> {
    const all = await this.readAll();
    return all.find((c) => c.id === id);
  }

  async list(q: PromptCandidateQuery = {}): Promise<PromptCandidate[]> {
    const all = await this.readAll();
    const filtered = all.filter((c) => matchCandidate(c, q));
    return sortAndPaginate(filtered, q, (c) => c.updatedAt);
  }

  async count(q: PromptCandidateQuery = {}): Promise<number> {
    return (await this.list({ ...q, limit: undefined, offset: undefined })).length;
  }

  async delete(id: string): Promise<void> {
    const all = await this.readAll();
    await this.writeAll(all.filter((c) => c.id !== id));
  }
}

// ── Trace stream (per-Run JSONL) ──────────────────────────────────────

async function* readEvents(file: string): AsyncIterable<SpanEvent> {
  if (!existsSync(file)) return;
  const stream = createReadStream(file, { encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    try {
      yield JSON.parse(line) as SpanEvent;
    } catch {
      // skip malformed
    }
  }
}

// ── Public factory ────────────────────────────────────────────────────

export interface FileStoreOptions {
  /** Root directory; created if missing. */
  rootDir: string;
  /** Filename for the runs log; default 'runs.jsonl'. */
  runsFile?: string;
  /** Filename for the spans log; default 'spans.jsonl'. */
  spansFile?: string;
  /** Filename for the evaluations log; default 'evaluations.jsonl'. */
  evalsFile?: string;
  /** Filename for the benchmarks JSON; default 'benchmarks.json'. */
  benchmarksFile?: string;
  /** Filename for the baselines JSON; default 'baselines.json'. */
  baselinesFile?: string;
  /** Filename for the prompt candidates JSON; default 'candidates.json'. */
  candidatesFile?: string;
  /** Subdirectory for trace streams; default 'traces'. */
  tracesDir?: string;
}

/**
 * Create a FileStore rooted at `rootDir`. Safe to call multiple times;
 * existing data is preserved.
 */
export async function createFileStore(opts: FileStoreOptions): Promise<Store> {
  await ensureDir(opts.rootDir);

  const runsFile = join(opts.rootDir, opts.runsFile ?? 'runs.jsonl');
  const spansFile = join(opts.rootDir, opts.spansFile ?? 'spans.jsonl');
  const evalsFile = join(opts.rootDir, opts.evalsFile ?? 'evaluations.jsonl');
  const benchmarksFile = join(opts.rootDir, opts.benchmarksFile ?? 'benchmarks.json');
  const baselinesFile = join(opts.rootDir, opts.baselinesFile ?? 'baselines.json');
  const candidatesFile = join(opts.rootDir, opts.candidatesFile ?? 'candidates.json');
  const tracesDir = join(opts.rootDir, opts.tracesDir ?? 'traces');
  await ensureDir(tracesDir);

  const runs = new FileRunRepo(runsFile);
  const spans = new FileSpanRepo(spansFile, runsFile);
  const evals = new FileEvalRepo(evalsFile);
  const benchmarks = new FileBenchmarkRepo(benchmarksFile);
  const baselines = new FileBaselineRepo(baselinesFile);
  const candidates = new FilePromptCandidateRepo(candidatesFile);

  return {
    runs,
    spans,
    evals,
    benchmarks,
    baselines,
    candidates,
    traceStream(runId: string): AsyncIterable<SpanEvent> {
      return readEvents(join(tracesDir, `${runId}.jsonl`));
    },
    async close(): Promise<void> {
      // Nothing to release; future SQLite impl will close handles here.
    },
  };
}

// ── Internal helpers (exported for tests) ─────────────────────────────

/**
 * Reduce a JSONL stream to a Map<id, latestRecord>. The last record
 * with a given id wins (append-only log = "last write wins").
 * Tombstones are preserved as the "latest" so deletes are honored.
 */
export function collapse<T extends { id: string }>(records: T[]): Map<string, T> {
  const map = new Map<string, T>();
  for (const r of records) {
    map.set(r.id, r);   // last write wins
  }
  return map;
}

/** Return the last record with the given id; append-only log semantics. */
function pickLatest<T extends { id: string }>(records: T[], id: string): T | undefined {
  let latest: T | undefined;
  for (const r of records) {
    if (r.id === id) latest = r;
  }
  return latest;
}

function isTombstone(r: RunRecord): r is { __deleted: true; id: string } {
  return (r as { __deleted?: boolean }).__deleted === true;
}

function isSpanTombstone(r: SpanRecord): r is { __deleted: true; id: string; runId: string } {
  return (r as { __deleted?: boolean }).__deleted === true;
}

const notTombstone = (r: RunRecord): r is AgentRun => !isTombstone(r);
const notSpanTombstone = (r: SpanRecord): r is AgentSpan => !isSpanTombstone(r);

function matchRun(r: AgentRun, q: RunQuery): boolean {
  if (q.status) {
    const allowed = Array.isArray(q.status) ? q.status : [q.status];
    if (!allowed.includes(r.status)) return false;
  }
  if (q.sessionId && r.sessionId !== q.sessionId) return false;
  if (q.fromTs !== undefined && r.startTime < q.fromTs) return false;
  if (q.toTs !== undefined && r.startTime >= q.toTs) return false;
  if (q.tagsAny && q.tagsAny.length > 0) {
    if (!q.tagsAny.some((t) => r.tags.includes(t))) return false;
  }
  return true;
}

function matchSpan(s: AgentSpan, q: SpanQuery): boolean {
  if (q.runId) {
    const allowed = Array.isArray(q.runId) ? q.runId : [q.runId];
    if (!allowed.includes(s.runId)) return false;
  }
  if (q.type) {
    const allowed = Array.isArray(q.type) ? q.type : [q.type];
    if (!allowed.includes(s.type)) return false;
  }
  if (q.status) {
    const allowed = Array.isArray(q.status) ? q.status : [q.status];
    if (!allowed.includes(s.status)) return false;
  }
  if (q.agent && s.agent !== q.agent) return false;
  if (q.fromTs !== undefined && s.startTime < q.fromTs) return false;
  if (q.toTs !== undefined && s.startTime >= q.toTs) return false;
  return true;
}

function matchEval(e: Evaluation, q: EvalQuery): boolean {
  if (q.runId && e.runId !== q.runId) return false;
  if (q.benchmarkId && e.benchmarkId !== q.benchmarkId) return false;
  if (q.pass !== undefined && e.pass !== q.pass) return false;
  if (q.fromTs !== undefined && e.timestamp < q.fromTs) return false;
  if (q.toTs !== undefined && e.timestamp >= q.toTs) return false;
  return true;
}

function matchBenchmark(b: Benchmark, q: BenchmarkQuery): boolean {
  if (q.difficulty) {
    const allowed = Array.isArray(q.difficulty) ? q.difficulty : [q.difficulty];
    if (!allowed.includes(b.difficulty)) return false;
  }
  if (q.tag && !b.tags.includes(q.tag)) return false;
  if (q.source && b.source?.dataset !== q.source) return false;
  return true;
}

function matchBaseline(b: Baseline, q: BaselineQuery): boolean {
  if (q.benchmarkId && b.benchmarkId !== q.benchmarkId) return false;
  if (q.name && b.name !== q.name) return false;
  return true;
}

function matchCandidate(c: PromptCandidate, q: PromptCandidateQuery): boolean {
  if (q.agentName && c.agentName !== q.agentName) return false;
  if (q.name && c.name !== q.name) return false;
  return true;
}

function sortAndPaginate<T>(arr: T[], q: ListQuery, key: (x: T) => number): T[] {
  const order = q.order ?? 'desc';
  const sorted = [...arr].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    return order === 'desc' ? kb - ka : ka - kb;
  });
  const offset = q.offset ?? 0;
  const limit = q.limit ?? 200;
  return sorted.slice(offset, offset + limit);
}

// ── Unused-but-exported status unions (preserve tree-shake) ──────────
export type { RunStatus, SpanStatus };

// Re-export the Store interface so consumers can import it from here.
export type { Store } from './types';
