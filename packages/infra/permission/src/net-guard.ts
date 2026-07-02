// NetGuard — outbound network allow-list.
//
// Policy (per SECURITY.md §4.2):
//   - LLM provider hosts allowed by default if listed in `allow`.
//   - Any other domain denied unless explicitly allowed.
//   - IP literals denied (avoid SSRF / data leak to internal nets).

import { ToolErrorCode } from '@ziner/infra-errors';

export interface NetPolicy {
  /** Allowed hostnames, e.g. ["api.openai.com", "*.openai.com"] */
  allow: string[];
  /** Denied hosts override allow. */
  deny?: string[];
  /** When true, block all outbound network. */
  offline?: boolean;
}

export class NetDeniedError extends Error {
  readonly code = ToolErrorCode.PermissionDenied;
  constructor(message: string) {
    super(message);
    this.name = 'NetDeniedError';
  }
}

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const IPV6 = /^\[[0-9a-f:]+\]$/i;

function isIpLiteral(host: string): boolean {
  return IPV4.test(host) || IPV6.test(host);
}

/** Minimal glob match for net allow-list. `*` matches one label. */
export function matchHost(pattern: string, host: string): boolean {
  // Wildcard subdomain: *.example.com matches a.example.com but NOT example.com
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(2).toLowerCase();
    const h = host.toLowerCase();
    return h !== suffix && h.endsWith('.' + suffix);
  }
  return pattern.toLowerCase() === host.toLowerCase();
}

/** Validate a URL against the policy. Throws on deny. */
export function assertUrlAllowed(url: string, policy: NetPolicy): URL {
  if (policy.offline) {
    throw new NetDeniedError('network disabled by policy (offline=true)');
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new NetDeniedError(`invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new NetDeniedError(`protocol not allowed: ${parsed.protocol}`);
  }
  const host = parsed.hostname;
  if (isIpLiteral(host)) {
    throw new NetDeniedError(`IP literals not allowed: ${host}`);
  }
  if (policy.deny?.some((p) => matchHost(p, host))) {
    throw new NetDeniedError(`host denied by policy: ${host}`);
  }
  if (!policy.allow.some((p) => matchHost(p, host))) {
    throw new NetDeniedError(`host not in allow-list: ${host}`);
  }
  return parsed;
}
