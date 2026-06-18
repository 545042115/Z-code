import { type ErrorRef } from '@z-assistant/contracts';
export interface FsPolicy {
    workspaceRoot: string;
    /** Glob patterns of paths that bypass the hidden-file block. */
    allowHidden?: string[];
    /** Glob patterns of paths always denied (overrides allow). */
    deny?: string[];
}
export declare class FsDeniedError extends Error {
    readonly ref: ErrorRef;
    readonly code: "2002";
    constructor(message: string, ref: ErrorRef);
}
/** Normalize and resolve `p` against the workspace root. */
export declare function resolveInWorkspace(p: string, workspaceRoot: string): string;
/** True when `target` is inside `root` (after normalization). */
export declare function isInside(target: string, root: string): boolean;
/** True when `target` looks like a system path. */
export declare function isSystemPath(target: string): boolean;
/**
 * Synchronous check: works on the provided path string. Does not
 * resolve symlinks. Use `assertPathSafe` for full safety.
 */
export declare function checkPath(p: string, policy: FsPolicy): {
    ok: true;
    resolved: string;
} | {
    ok: false;
    code: string;
    message: string;
};
/** Async: resolve symlinks first, then check. */
export declare function assertPathSafe(p: string, policy: FsPolicy): Promise<string>;
//# sourceMappingURL=fs-guard.d.ts.map