// FsGuard — validate file paths against a workspace root.
//
// Policy (per SECURITY.md §4.1):
//   - Paths inside `workspaceRoot` (and its sub-dirs) are allowed.
//   - Symlinks that resolve outside the root are denied.
//   - Hidden files (dot-prefixed) and system directories are denied
//     unless the user explicitly allow-lists them.

import { realpath, stat } from 'fs/promises';
import { resolve, relative, sep, isAbsolute } from 'path';
import { matchGlob, type ErrorRef } from '@z-assistant/contracts';
import { ToolErrorCode } from '@z-assistant/infra-errors';

export interface FsPolicy {
  workspaceRoot: string;
  /** Glob patterns of paths that bypass the hidden-file block. */
  allowHidden?: string[];
  /** Glob patterns of paths always denied (overrides allow). */
  deny?: string[];
}

export class FsDeniedError extends Error {
  readonly code = ToolErrorCode.PermissionDenied;
  constructor(message: string, public readonly ref: ErrorRef) {
    super(message);
    this.name = 'FsDeniedError';
  }
}

/** Normalize and resolve `p` against the workspace root. */
export function resolveInWorkspace(p: string, workspaceRoot: string): string {
  return isAbsolute(p) ? resolve(p) : resolve(workspaceRoot, p);
}

/** True when `target` is inside `root` (after normalization). */
export function isInside(target: string, root: string): boolean {
  const rel = relative(root, target);
  return !!rel && !rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel);
}

const SYSTEM_PREFIXES_WIN = [
  'C:\\Windows', 'C:\\Program Files', 'C:\\ProgramData',
  process.env.SystemRoot ?? 'C:\\Windows',
].filter(Boolean);
const SYSTEM_PREFIXES_NIX = ['/etc', '/usr', '/var', '/bin', '/sbin', '/boot', '/proc', '/sys', '/dev'];

/** True when `target` looks like a system path. */
export function isSystemPath(target: string): boolean {
  const t = target.toLowerCase();
  if (process.platform === 'win32') {
    return SYSTEM_PREFIXES_WIN.some((p) => t.startsWith(p.toLowerCase()));
  }
  return SYSTEM_PREFIXES_NIX.some((p) => t === p || t.startsWith(p + '/'));
}

const HIDDEN_FILE = /(^|[\\/])\.[^\\/]+$/;

/**
 * Synchronous check: works on the provided path string. Does not
 * resolve symlinks. Use `assertPathSafe` for full safety.
 */
export function checkPath(p: string, policy: FsPolicy): { ok: true; resolved: string }
                                                       | { ok: false; code: string; message: string } {
  const resolved = resolveInWorkspace(p, policy.workspaceRoot);
  if (!isInside(resolved, policy.workspaceRoot)) {
    return { ok: false, code: ToolErrorCode.PermissionDenied, message: `path outside workspace: ${p}` };
  }
  if (policy.deny && policy.deny.some((g) => matchGlob(g, resolved))) {
    return { ok: false, code: ToolErrorCode.PermissionDenied, message: `path denied by policy: ${p}` };
  }
  if (HIDDEN_FILE.test(resolved) &&
      !(policy.allowHidden ?? []).some((g) => matchGlob(g, resolved))) {
    return { ok: false, code: ToolErrorCode.PermissionDenied, message: `hidden file denied: ${p}` };
  }
  if (isSystemPath(resolved)) {
    return { ok: false, code: ToolErrorCode.PermissionDenied, message: `system path denied: ${p}` };
  }
  return { ok: true, resolved };
}

/** Async: resolve symlinks first, then check. */
export async function assertPathSafe(p: string, policy: FsPolicy): Promise<string> {
  const sync = checkPath(p, policy);
  if (!sync.ok) throw new FsDeniedError(sync.message, { code: sync.code, message: sync.message });
  try {
    const real = await realpath(sync.resolved);
    if (!isInside(real, policy.workspaceRoot)) {
      throw new FsDeniedError(`symlink escapes workspace: ${p}`, {
        code: ToolErrorCode.PermissionDenied,
        message: 'symlink target outside workspace',
      });
    }
    return real;
  } catch (e) {
    if (e instanceof FsDeniedError) throw e;
    // Path doesn't exist yet — stat will fail; that's fine for write paths.
    try {
      await stat(sync.resolved);
    } catch {
      // Path doesn't exist; check is the best we can do.
    }
    return sync.resolved;
  }
}
