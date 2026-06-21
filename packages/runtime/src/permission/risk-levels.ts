// @z-assistant/runtime — Universal tool risk classification (P1-2).
//
// Promotes the rule-engine pattern from `computer-use.ts` to a universal
// `ToolRiskClassifier` that covers every tool in the chat-agent's arsenal
// (web / file / shell / browser / perception).
//
// Risk levels follow the 5-tier scale defined in `contracts/confirmation.ts`:
//   safe → low → medium → high → critical
//
// 'critical' calls are blocked unconditionally (rm -rf, drop database, etc.).
// 'high' and 'medium' calls trigger a confirmation prompt.
// 'safe' and 'low' calls execute without prompting (unless the tool's
// `requiresConfirmation` flag or the ToolPolicy's `requireConfirm` list
// says otherwise).

import type { RiskClassification, RiskLevel } from '@z-assistant/contracts';
import { isDangerousCommand } from '@z-assistant/infra-permission';

// ── Risk rules ───────────────────────────────────────────────────────

/**
 * A rule that classifies a tool call's risk.
 *
 * Rules are evaluated in order; the first match wins (like computer-use's
 * ActionSafetyRule). A rule matches when `match(toolName, args)` returns
 * true. The `risk` and `warning` of the matching rule become the
 * classification result.
 */
export interface ToolRiskRule {
  /** Human-readable name for debugging / audit. */
  name: string;
  /** Returns true if this rule applies to the given tool call. */
  match: (toolName: string, args: Record<string, unknown>) => boolean;
  /** Risk level if this rule matches. */
  risk: RiskLevel;
  /** Human-readable warning shown to the user. */
  warning: string;
}

// ── Default risk rules ───────────────────────────────────────────────
//
// Ordered from most specific (critical shell patterns) to least specific
// (safe read-only tools). First match wins.

export const DEFAULT_TOOL_RISK_RULES: ToolRiskRule[] = [
  // Note: prompt-injection / jailbreak detection is handled centrally by
  // ConfirmationGate before classifyToolCall is called, so it is intentionally
  // NOT duplicated here. This avoids scanning the same arguments twice.

  // ── Critical: dangerous shell commands (rm -rf, git push --force, etc.) ──
  {
    name: 'shell.dangerous-command',
    match: (name, args) => {
      if (name !== 'run_terminal') return false;
      const cmd = String(args.command ?? args.cmd ?? '');
      return isDangerousCommand(cmd);
    },
    risk: 'critical',
    warning: 'This command is classified as dangerous and will be blocked.',
  },

  // ── High: risky but reversible git operations ──
  {
    name: 'shell.git-destructive',
    match: (name, args) => {
      if (name !== 'run_terminal') return false;
      const cmd = String(args.command ?? args.cmd ?? '');
      return /\bgit\s+reset\s+--hard\b/.test(cmd)
        || /\bgit\s+clean\s+-[fd]/.test(cmd)
        || /\bgit\s+checkout\s+\.\s*$/.test(cmd);
    },
    risk: 'high',
    warning: 'This git command discards uncommitted changes.',
  },

  // ── High: shell execution ──
  {
    name: 'shell.any',
    match: (name) => name === 'run_terminal',
    risk: 'high',
    warning: 'Executing a shell command. This can modify files, install software, or make network requests.',
  },

  // ── Medium: file writes / edits ──
  {
    name: 'file.write',
    match: (name) => name === 'write_file' || name === 'replace_text',
    risk: 'medium',
    warning: 'Modifying a file. Changes can be reversed with version control.',
  },
  {
    name: 'file.append',
    match: (name) => name === 'append_text' || name === 'insert_text',
    risk: 'low',
    warning: 'Appending to a file.',
  },

  // ── Critical: browser navigation to dangerous schemes ──
  {
    name: 'browser.dangerous-scheme',
    match: (name, args) => {
      if (name !== 'browser_navigate') return false;
      const url = String(args.url ?? '');
      if (url.length === 0) return false;
      // Only http(s) are allowed. about: is explicitly denied because it can
      // be used to access browser internals (about:config, about:blank XSS).
      return !(url.startsWith('http://') || url.startsWith('https://'));
    },
    risk: 'critical',
    warning: 'Navigating to a URL with a non-HTTP(S) scheme is blocked for safety.',
  },

  // ── Medium: browser navigation to non-HTTPS HTTP URL ──
  {
    name: 'browser.insecure-nav',
    match: (name, args) => {
      if (name !== 'browser_navigate') return false;
      const url = String(args.url ?? '');
      return url.startsWith('http://');
    },
    risk: 'medium',
    warning: 'Navigating to a non-HTTPS URL. Data may be transmitted in plaintext.',
  },

  // ── Low: browser actions ──
  {
    name: 'browser.any',
    match: (name) => name.startsWith('browser_'),
    risk: 'low',
    warning: 'Performing a browser action.',
  },

  // ── Low: web fetch (reads external content) ──
  {
    name: 'web.fetch',
    match: (name) => name === 'web_fetch',
    risk: 'low',
    warning: 'Fetching content from an external URL.',
  },

  // ── Safe: read-only tools ──
  {
    name: 'read.any',
    match: (name) =>
      name === 'read_file' ||
      name === 'search_code' ||
      name === 'list_directory' ||
      name === 'get_project_context' ||
      name === 'web_search' ||
      name === 'browser_screenshot' ||
      name === 'ocr_image' ||
      name === 'describe_image' ||
      name === 'transcribe_audio' ||
      name === 'parse_document',
    risk: 'safe',
    warning: '',
  },

  // ── Default: unknown tools get medium risk (cautious) ──
  {
    name: 'unknown',
    match: () => true,
    risk: 'medium',
    warning: 'This tool is not in the known risk registry; treating as medium risk.',
  },
];

// ── Classifier ───────────────────────────────────────────────────────

/**
 * Classify a tool call's risk using the provided rules.
 *
 * Uses `DEFAULT_TOOL_RISK_RULES` if no rules are supplied. First match
 * wins. If no rule matches (shouldn't happen since the default set has
 * a catch-all), returns medium risk.
 *
 * `blocked` is true when risk is 'critical'.
 */
export function classifyToolCall(
  toolName: string,
  args: Record<string, unknown>,
  rules: ToolRiskRule[] = DEFAULT_TOOL_RISK_RULES,
): RiskClassification {
  for (const rule of rules) {
    if (rule.match(toolName, args)) {
      return {
        risk: rule.risk,
        warning: rule.warning || undefined,
        blocked: rule.risk === 'critical',
        matchedRule: rule.name,
      };
    }
  }
  // Fallback (shouldn't reach here due to the catch-all rule).
  return {
    risk: 'medium',
    warning: 'No risk rule matched; defaulting to medium.',
    blocked: false,
    matchedRule: 'fallback',
  };
}

// ── Risk level helpers ───────────────────────────────────────────────

/**
 * Returns true if the risk level requires a confirmation prompt.
 *
 * 'safe' and 'low' do not require confirmation.
 * 'medium' and 'high' require confirmation.
 * 'critical' is blocked (not confirmable).
 */
export function requiresConfirmation(risk: RiskLevel): boolean {
  return risk === 'medium' || risk === 'high';
}

/**
 * Compare risk levels. Returns negative if a < b, 0 if equal, positive if a > b.
 */
export function compareRisk(a: RiskLevel, b: RiskLevel): number {
  const order: RiskLevel[] = ['safe', 'low', 'medium', 'high', 'critical'];
  return order.indexOf(a) - order.indexOf(b);
}


