// ToolGuard — runtime wrapper around the `ToolPolicy` from contracts.
// Re-exports the policy check helpers and adds a pre-call hook that
// throws when the call is denied.

import { isToolAllowed, toolRequiresConfirm, type ToolPolicy } from '../../contracts';
import { ToolErrorCode } from '../errors';

export class ToolDeniedError extends Error {
  readonly code = ToolErrorCode.PermissionDenied;
  constructor(message: string) {
    super(message);
    this.name = 'ToolDeniedError';
  }
}

export class DangerousCommandError extends Error {
  readonly code = ToolErrorCode.DangerousCommandBlocked;
  constructor(message: string) {
    super(message);
    this.name = 'DangerousCommandError';
  }
}

export interface ToolGuardOptions {
  /** When true, `assertToolAllowed` will return whether confirmation is needed. */
  policy: ToolPolicy;
}

/** Pre-call check. Throws if denied. Returns whether confirmation is needed. */
export function assertToolAllowed(toolName: string, policy: ToolPolicy): { needsConfirm: boolean } {
  if (!isToolAllowed(policy, toolName)) {
    throw new ToolDeniedError(`tool not allowed by policy: ${toolName}`);
  }
  return { needsConfirm: toolRequiresConfirm(policy, toolName) };
}

/**
 * Check a shell command for dangerous patterns. This is a hard block:
 * the command cannot be approved at runtime (per SECURITY.md §4.3).
 */
const DANGEROUS_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /\brm\s+-rf?\s+\//,                  reason: 'rm -rf on root' },
  { re: /\brm\s+-rf?\s+~(?:\/|\s|$)/,        reason: 'rm -rf on home' },
  { re: /\bgit\s+push\s+(-f|--force)(?:\b|$)/, reason: 'force push' },
  { re: /\bgit\s+push\s+--force-with-lease/, reason: 'force push (with-lease)' },
  { re: /:\(\)\s*\{.*\};:/,                 reason: 'fork bomb' },
  { re: /\bdd\s+if=.+of=\/dev\//,            reason: 'dd to device' },
  { re: /\bchmod\s+-R\s+777\b/,              reason: 'chmod 777' },
  { re: /\bmkfs(\.\w+)?\s+\/dev\//,          reason: 'mkfs on device' },
];

export function checkDangerousCommand(cmd: string): void {
  for (const { re, reason } of DANGEROUS_PATTERNS) {
    if (re.test(cmd)) {
      throw new DangerousCommandError(`blocked dangerous command: ${reason}`);
    }
  }
}
