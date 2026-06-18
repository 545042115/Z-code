import type { RunStatus, SpanStatus } from '@z-assistant/contracts';
import type { Store } from './types';
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
export declare function createFileStore(opts: FileStoreOptions): Promise<Store>;
/**
 * Reduce a JSONL stream to a Map<id, latestRecord>. The last record
 * with a given id wins (append-only log = "last write wins").
 * Tombstones are preserved as the "latest" so deletes are honored.
 */
export declare function collapse<T extends {
    id: string;
}>(records: T[]): Map<string, T>;
export type { RunStatus, SpanStatus };
export type { Store } from './types';
//# sourceMappingURL=jsonl-store.d.ts.map