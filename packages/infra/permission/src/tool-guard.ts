// ToolGuard — runtime wrapper around the `ToolPolicy` from contracts.
// Re-exports the policy check helpers and adds a pre-call hook that
// throws when the call is denied.

import { isToolAllowed, toolRequiresConfirm, type ToolPolicy } from '@z-assistant/contracts';
import { ToolErrorCode } from '@z-assistant/infra-errors';

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
 *
 * Patterns merged from V1 (`extensions/coding-agent/.../tool-registry.ts`)
 * and V2. Only truly critical (irreversible) patterns belong here;
 * high-risk-but-reversible patterns (git reset --hard, git clean -f)
 * are handled by the risk classifier in `runtime/permission/risk-levels.ts`.
 */
const DANGEROUS_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  // ── Irreversible deletion ──
  { re: /\brm\s+-rf?\s+\//,                  reason: 'rm -rf on root' },
  { re: /\brm\s+-rf?\s+~(?:\/|\s|$)/,        reason: 'rm -rf on home' },
  { re: /\bdel\s+\/[sfq]/i,                   reason: 'Windows del /f/q/s (force delete)' },
  // ── Disk / filesystem destruction ──
  { re: /\bformat\s+[a-z]:/i,                 reason: 'format disk (Windows)' },
  { re: /\bmkfs(\.\w+)?\s+\/dev\//,           reason: 'mkfs on device' },
  { re: /\bdd\s+if=.+of=\/dev\//,             reason: 'dd to device' },
  // ── System shutdown / reboot ──
  { re: /\bshutdown\b/i,                      reason: 'system shutdown' },
  { re: /\breboot\b/i,                        reason: 'system reboot' },
  // ── Force push (overwrites remote history, irreversible) ──
  { re: /\bgit\s+push\s+(-f|--force)(?:\b|$)/, reason: 'force push' },
  { re: /\bgit\s+push\s+--force-with-lease/,  reason: 'force push (with-lease)' },
  // ── Permission weakening ──
  { re: /\bchmod\s+-R\s+777\b/,               reason: 'chmod 777' },
  // ── Fork bomb ──
  { re: /:\(\)\s*\{.*\};:/,                   reason: 'fork bomb' },
];

/**
 * Returns true if the command matches a dangerous pattern (throws version).
 * @deprecated Use `isDangerousCommand` instead (boolean, no throw).
 */
export function checkDangerousCommand(cmd: string): void {
  for (const { re, reason } of DANGEROUS_PATTERNS) {
    if (re.test(cmd)) {
      throw new DangerousCommandError(`blocked dangerous command: ${reason}`);
    }
  }
}

/**
 * Returns true if the command matches a dangerous pattern.
 * Does not throw; safe to use in risk classifiers.
 */
export function isDangerousCommand(cmd: string): boolean {
  return DANGEROUS_PATTERNS.some(({ re }) => re.test(cmd));
}
