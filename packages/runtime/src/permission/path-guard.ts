// @ziner/runtime — Path Guard (Sandbox layer 2)
//
// Restricts file-system tool operations to a set of allowed root directories.
// Prevents agents from reading/writing arbitrary files outside the project
// or storage dir.

import { isAbsolute, resolve, normalize } from 'path';
import { realpathSync } from 'fs';

export interface PathGuardOptions {
  /** Root directories that tool file paths must stay within. */
  allowedRoots: string[];
  /** Whether to allow absolute paths at all. Default true. */
  allowAbsolute?: boolean;
}

/**
 * Normalise a path and resolve symlinks so traversal checks cannot be
 * bypassed with `..` or symlinks.
 */
function safeResolve(p: string): string | undefined {
  if (!p || typeof p !== 'string') return undefined;
  const abs = isAbsolute(p) ? normalize(resolve(p)) : normalize(resolve(process.cwd(), p));
  try {
    return realpathSync(abs);
  } catch {
    // realpath fails if the path does not exist; fall back to the resolved
    // absolute path. This is safe for write operations that create the file.
    return abs;
  }
}

/**
 * Check whether a file path is within any of the allowed roots.
 *
 * Returns `{ allowed, normalized }`. If `allowed` is false, the path is
 * outside all allowed roots.
 */
export function checkPath(p: string, opts: PathGuardOptions): { allowed: boolean; normalized?: string } {
  if (opts.allowAbsolute === false && isAbsolute(p)) {
    return { allowed: false };
  }
  const normalized = safeResolve(p);
  if (!normalized) return { allowed: false };

  const roots = opts.allowedRoots.map((r) => safeResolve(r) ?? normalize(resolve(r)));
  const inside = roots.some((root) => normalized === root || normalized.startsWith(root + '\\') || normalized.startsWith(root + '/'));
  return { allowed: inside, normalized };
}

/**
 * Extract file paths from common tool arguments.
 */
export function extractFilePaths(args: Record<string, unknown>): string[] {
  const paths: string[] = [];
  const candidates = [args.filePath, args.path, args.dirPath, args.cwd];
  for (const c of candidates) {
    if (typeof c === 'string' && c.length > 0) paths.push(c);
  }
  return paths;
}
