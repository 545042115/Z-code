// Secrets — load API keys from environment or OS keychain.
//
// Per SECURITY.md §5: API keys MUST NOT be written to SQLite/JSONL/logs.
// This module is the only sanctioned way to read them.
//
// Phase 0 implementation: env vars + process.env lookup.
// Phase 1 will add OS Keychain (DPAPI / Keychain / Secret Service) via
// the existing `keytar` dependency that's already in node_modules.

export class SecretNotFoundError extends Error {
  readonly code = '5004';
  constructor(name: string) {
    super(`secret not found: ${name}`);
    this.name = 'SecretNotFoundError';
  }
}

/** Look up a secret by name. Throws SecretNotFoundError when missing. */
export function loadSecret(name: string): string {
  const v = process.env[name];
  if (v && v.length > 0) return v;
  throw new SecretNotFoundError(name);
}

/** Return a secret or undefined (no throw). */
export function tryLoadSecret(name: string): string | undefined {
  return process.env[name] || undefined;
}
