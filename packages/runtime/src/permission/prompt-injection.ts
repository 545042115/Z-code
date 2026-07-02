// @ziner/runtime — Prompt Injection Detector (P1-2 Stage E).
//
// Heuristic scanner for prompt-injection / jailbreak attempts embedded
// in tool arguments, assistant messages, or user content.
//
// The detector is deliberately lightweight and zero-dependency. It
// complements (but does not replace) future LLM-based classifiers:
//   - pattern matching for common injection payloads
//   - simple obfuscation decoding (URL, hex, base64)
//   - confidence scoring per rule
//   - configurable block threshold
//
// Detected injections are escalated to 'critical' risk by
// ConfirmationGate and blocked before tool execution.

import type {
  IPromptInjectionDetector,
  PromptInjectionDetectorOptions,
  PromptInjectionMatch,
  PromptInjectionReport,
  PromptInjectionRule,
} from '@ziner/contracts';

// ── Default rule set ─────────────────────────────────────────────────

const DEFAULT_RULES: PromptInjectionRule[] = [
  {
    id: 'ignore-previous',
    type: 'ignore-previous',
    pattern: /\bignore\s+(?:the\s+)?(?:above|previous|prior)\s+(?:instructions?|prompt|commands?)\b/gi,
    confidence: 0.95,
    reason: 'Directive to ignore previous instructions.',
  },
  {
    id: 'ignore-all',
    type: 'ignore-previous',
    pattern: /\bignore\s+all\s+(?:previous\s+)?(?:instructions?|constraints?)\b/gi,
    confidence: 0.95,
    reason: 'Directive to ignore all instructions or constraints.',
  },
  {
    id: 'system-prompt-leak',
    type: 'system-prompt-leak',
    pattern: /\b(?:print|repeat|show|output|return|leak)\s+(?:your\s+)?(?:system\s+prompt|instructions|initial\s+prompt|developer\s+message)\b/gi,
    confidence: 0.85,
    reason: 'Attempt to leak system prompt or instructions.',
  },
  {
    id: 'role-confusion-user',
    type: 'role-confusion',
    pattern: /\byou\s+are\s+(?:now\s+)?(?:an?\s+)?(?:unrestricted?|uncensored?|jailbroken?|developer|admin|root|superuser|DAN|do\s+anything\s+now)\b/gi,
    confidence: 0.9,
    reason: 'Attempt to redefine the assistant role to bypass safety.',
  },
  {
    id: 'role-confusion-assistant',
    type: 'role-confusion',
    pattern: /\bfrom\s+now\s+on\s+you\s+are\b/gi,
    confidence: 0.8,
    reason: 'Attempt to redefine the assistant role.',
  },
  {
    id: 'instruction-override',
    type: 'instruction-override',
    pattern: /\b(?:disregard|forget|remove|drop|override|bypass|disable|turn\s+off)\s+(?:your\s+)?(?:safety\s+)?(?:instructions?|rules?|constraints?|safeguards?|filter|moderation|guidelines?)\b/gi,
    confidence: 0.85,
    reason: 'Attempt to override or disable safety instructions.',
  },
  {
    id: 'delimiter-break',
    type: 'delimiter-break',
    pattern: /(?<!\w)```\s*(?:system|user|assistant)\b/gi,
    confidence: 0.75,
    reason: 'Markdown code block used to impersonate a role boundary.',
  },
  {
    id: 'hidden-injection-html',
    type: 'hidden-injection',
    // Bounded character class [^>] prevents catastrophic backtracking on
    // malformed HTML comments that never close.
    pattern: /<![ \t]*--[^>]{0,256}?ignore[^>]{0,64}?(?:instruction|prompt)[^>]{0,256}?--[ \t]*>/gi,
    confidence: 0.8,
    reason: 'Hidden HTML comment attempting to smuggle instructions.',
  },
  {
    id: 'hidden-injection-css',
    type: 'hidden-injection',
    // Bounded character class [^*] prevents catastrophic backtracking on
    // malformed CSS comments that never close.
    pattern: /\/\*[^*]{0,256}?ignore[^*]{0,64}?(?:instruction|prompt)[^*]{0,256}?\*\//gi,
    confidence: 0.8,
    reason: 'Hidden CSS/JS comment attempting to smuggle instructions.',
  },
  {
    id: 'jailbreak-dan',
    type: 'jailbreak',
    pattern: /\bDAN\b|\bdo\s+anything\s+now\b/gi,
    confidence: 0.9,
    reason: 'Known jailbreak framing (DAN / Do Anything Now).',
  },
  {
    id: 'encoding-obfuscation',
    type: 'encoding-obfuscation',
    pattern: /\b(?:base64|hex|url|percent|rot13|decode)\s+(?:decode|encoded|obfuscated)\s+(?:instruction|prompt|command)\b/gi,
    confidence: 0.7,
    reason: 'Explicit mention of encoded/obfuscated instructions.',
  },
];

// ── Helpers ──────────────────────────────────────────────────────────

function normalizeText(input: string): string {
  return input
    .normalize('NFKC')
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tryDecode(text: string): string {
  const parts: string[] = [text];

  // Split into candidate tokens so obfuscated payloads hidden inside
  // larger strings (e.g. file paths, JSON) are still decoded.
  const tokens = text.split(/\s+|['"`,;<>()[\]{}]/).filter((t) => t.length >= 4);

  for (const token of tokens) {
    try {
      // URL-encoded token (must contain %XX).
      if (token.includes('%')) {
        const urlDecoded = decodeURIComponent(token.replace(/\+/g, ' '));
        if (urlDecoded !== token && /^[\x20-\x7E\s]+$/.test(urlDecoded)) {
          parts.push(urlDecoded);
        }
      }
    } catch { /* ignore */ }

    try {
      // Hex token (only hex chars, even length, >= 6 chars).
      const hex = token.replace(/\s/g, '');
      if (/^[0-9a-fA-F]+$/.test(hex) && hex.length >= 6 && hex.length % 2 === 0) {
        const decoded = Buffer.from(hex, 'hex').toString('utf8');
        if (decoded && decoded !== token && /^[\x20-\x7E\s]+$/.test(decoded)) {
          parts.push(decoded);
        }
      }
    } catch { /* ignore */ }

    try {
      // Base64 token.
      const b64 = token.replace(/\s/g, '');
      if (/^[A-Za-z0-9+/]*={0,2}$/.test(b64) && b64.length >= 8 && b64.length % 4 === 0) {
        const decoded = Buffer.from(b64, 'base64').toString('utf8');
        if (decoded && decoded !== token && /^[\x20-\x7E\s]+$/.test(decoded)) {
          parts.push(decoded);
        }
      }
    } catch { /* ignore */ }
  }

  return parts.join('\n');
}

function stringifyArgs(args: Record<string, unknown>): string {
  const values: string[] = [];
  function walk(value: unknown): void {
    if (value === null || value === undefined) return;
    if (typeof value === 'string') values.push(value);
    else if (typeof value === 'number' || typeof value === 'boolean') values.push(String(value));
    else if (Array.isArray(value)) value.forEach(walk);
    else if (typeof value === 'object') Object.values(value).forEach(walk);
  }
  walk(args);
  return values.join(' ');
}

// ── Implementation ───────────────────────────────────────────────────

export class PromptInjectionDetector implements IPromptInjectionDetector {
  private readonly rules: PromptInjectionRule[];
  private readonly blockThreshold: number;
  private readonly decodeObfuscation: boolean;

  constructor(opts: PromptInjectionDetectorOptions = {}) {
    this.rules = [...DEFAULT_RULES, ...(opts.extraRules ?? [])];
    this.blockThreshold = opts.blockThreshold ?? 0.6;
    this.decodeObfuscation = opts.decodeObfuscation ?? true;
  }

  scan(text: string): PromptInjectionReport {
    const normalized = normalizeText(text);
    const scanned = this.decodeObfuscation ? tryDecode(normalized) : normalized;
    const matches: PromptInjectionMatch[] = [];

    for (const rule of this.rules) {
      const pattern = typeof rule.pattern === 'string'
        ? new RegExp(rule.pattern, 'gi')
        : new RegExp(rule.pattern.source, rule.pattern.flags.includes('g') ? rule.pattern.flags : rule.pattern.flags + 'g');
      const seen = new Set<string>();
      let m: RegExpExecArray | null;
      while ((m = pattern.exec(scanned)) !== null) {
        const snippet = m[0].slice(0, 200);
        if (seen.has(snippet)) continue;
        seen.add(snippet);
        matches.push({
          type: rule.type,
          snippet,
          confidence: rule.confidence,
          reason: rule.reason,
        });
      }
    }

    const maxConfidence = matches.length > 0 ? Math.max(...matches.map((x) => x.confidence)) : 0;
    const injected = maxConfidence >= this.blockThreshold;

    return {
      injected,
      maxConfidence,
      matches,
      scannedText: scanned,
    };
  }

  scanArgs(args: Record<string, unknown>): PromptInjectionReport {
    return this.scan(stringifyArgs(args));
  }
}

export { DEFAULT_RULES };

// ── Convenience factory ──────────────────────────────────────────────

export function createPromptInjectionDetector(opts?: PromptInjectionDetectorOptions): PromptInjectionDetector {
  return new PromptInjectionDetector(opts);
}
