// @z-assistant/runtime — ConfirmationGate (P1-2 HITL core).
//
// Sits between the agent and tool execution. For every tool call:
//
//   1. Classify risk via `classifyToolCall()`.
//   2. If blocked (critical) → return 'deny' immediately.
//   3. Check always-rules (persisted user decisions):
//      - If an 'always-allow' rule matches → return 'allow'.
//      - If an 'always-deny' rule matches → return 'deny'.
//   4. If risk is safe/low and no explicit confirm required → return 'allow'.
//   5. Otherwise → emit a ConfirmationRequest to the UI callback and
//      await the user's Decision.
//   6. If the user picks 'always-allow'/'always-deny', persist a new rule.
//
// The UI callback is injected via `ConfirmationGateOptions.onRequest`, so
// the gate is UI-agnostic: Desktop wires it to an IPC modal, CLI wires
// it to an inline prompt, tests wire it to an auto-allow stub.

import type {
  AlwaysRule,
  ConfirmationRequest,
  Decision,
  IConfirmationGate,
  ToolInvocation,
  ToolPreview,
} from '@z-assistant/contracts';
import { randomUUID } from 'node:crypto';
import {
  classifyToolCall,
  requiresConfirmation,
  type ToolRiskRule,
} from './risk-levels';
import type { IAuditLogger } from '../audit/logger';

// ── Options ──────────────────────────────────────────────────────────

/**
 * Callback that renders a ConfirmationRequest to the user and returns
 * their Decision.
 *
 * Implementations:
 * - Desktop: IPC → renderer modal → IPC back (blocking Promise)
 * - CLI: inline stdin prompt
 * - Test: auto-allow / auto-deny stub
 */
export type ConfirmationHandler = (req: ConfirmationRequest) => Promise<Decision>;

/**
 * Callback that persists an always-rule so future matching calls skip
 * the UI. Optional; if not provided, 'always-allow'/'always-deny' degrade
 * to one-shot 'allow'/'deny'.
 */
export type AlwaysRulePersister = (rule: AlwaysRule) => void;

export interface ConfirmationGateOptions {
  /** Renders the confirmation request to the user. */
  onRequest: ConfirmationHandler;
  /** Optional: persists always-rules. */
  onPersistRule?: AlwaysRulePersister;
  /** Optional: pre-loaded always-rules (e.g. from disk). */
  rules?: AlwaysRule[];
  /** Optional: custom risk rules (defaults to DEFAULT_TOOL_RISK_RULES). */
  riskRules?: ToolRiskRule[];
  /** Optional: generate preview for the confirmation UI. */
  previewGenerator?: (toolName: string, args: Record<string, unknown>) => ToolPreview | undefined;
  /** Optional: run id for audit correlation. */
  runId?: string;
  /** Optional: user id for audit. */
  userId?: string;
  /** Optional: audit logger. If provided, every decision is recorded. */
  auditLogger?: IAuditLogger;
}

// ── Glob matching for always-rules ───────────────────────────────────

/**
 * Minimal glob matcher: supports `*` (any chars) and `?` (one char).
 * Used to match arg values in AlwaysRule.argPatterns.
 */
function globMatch(pattern: string, value: string): boolean {
  // Convert glob to regex: * → .*, ? → ., escape everything else.
  let regex = '^';
  for (const ch of pattern) {
    if (ch === '*') regex += '.*';
    else if (ch === '?') regex += '.';
    else regex += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  regex += '$';
  return new RegExp(regex, 'i').test(value);
}

/**
 * Check if an always-rule matches a tool invocation.
 */
function ruleMatches(rule: AlwaysRule, toolName: string, args: Record<string, unknown>): boolean {
  if (rule.toolName !== toolName) return false;
  if (!rule.argPatterns) return true; // no arg patterns → match all calls to this tool
  for (const [key, pattern] of Object.entries(rule.argPatterns)) {
    const val = String(args[key] ?? '');
    if (!globMatch(pattern, val)) return false;
  }
  return true;
}

// ── ConfirmationGate ─────────────────────────────────────────────────

/**
 * The confirmation gate implementation.
 *
 * Usage:
 *   const gate = new ConfirmationGate({ onRequest: myUIHandler });
 *   const decision = await gate.confirm({ id, toolName: 'run_terminal', args: { command: 'rm -rf /' } });
 *   if (decision === 'deny') { /* skip execution *\/ }
 */
export class ConfirmationGate implements IConfirmationGate {
  private readonly opts: ConfirmationGateOptions;
  private readonly rules: AlwaysRule[];

  constructor(opts: ConfirmationGateOptions) {
    this.opts = opts;
    this.rules = opts.rules ? [...opts.rules] : [];
  }

  /** Add an always-rule at runtime (e.g. loaded from disk later). */
  addRule(rule: AlwaysRule): void {
    this.rules.push(rule);
  }

  /** Remove an always-rule by id. */
  removeRule(id: string): boolean {
    const idx = this.rules.findIndex((r) => r.id === id);
    if (idx >= 0) {
      this.rules.splice(idx, 1);
      return true;
    }
    return false;
  }

  /** List all active always-rules (for the settings UI). */
  listRules(): AlwaysRule[] {
    return [...this.rules];
  }

  async confirm(invocation: ToolInvocation): Promise<Decision> {
    const { toolName, args } = invocation;
    const audit = this.opts.auditLogger;
    const auditBase = {
      runId: this.opts.runId,
      invocationId: invocation.id,
      toolName,
      args,
      userId: this.opts.userId,
    };

    // 1. Classify risk.
    const classification = classifyToolCall(toolName, args, this.opts.riskRules);

    // 2. Critical → blocked unconditionally.
    if (classification.blocked) {
      audit?.logPending({ ...auditBase, risk: classification.risk, blocked: true, matchedRuleId: classification.matchedRule });
      return 'deny';
    }

    // 3. Check always-rules (first match wins).
    for (const rule of this.rules) {
      if (ruleMatches(rule, toolName, args)) {
        const decision = rule.decision === 'always-allow' ? 'allow' : 'deny';
        audit?.logPending({ ...auditBase, risk: classification.risk, decision, matchedRuleId: rule.id });
        return decision;
      }
    }

    // 4. Safe/low risk and no explicit confirm needed → auto-allow.
    if (!requiresConfirmation(classification.risk)) {
      audit?.logPending({ ...auditBase, risk: classification.risk, decision: 'allow' });
      return 'allow';
    }

    // 5. Emit confirmation request to the UI.
    const preview = this.opts.previewGenerator?.(toolName, args);
    const request: ConfirmationRequest = {
      id: randomUUID(),
      invocation,
      risk: classification.risk,
      reason: classification.warning ?? `Tool '${toolName}' has risk level '${classification.risk}'.`,
      preview,
      createdAt: Date.now(),
    };

    const decision = await this.opts.onRequest(request);

    // 6. Audit the user's decision.
    audit?.logPending({ ...auditBase, risk: classification.risk, decision });

    // 7. Persist 'always' decisions.
    if (decision === 'always-allow' || decision === 'always-deny') {
      const rule: AlwaysRule = {
        id: randomUUID(),
        decision,
        toolName,
        createdAt: Date.now(),
      };
      this.rules.push(rule);
      this.opts.onPersistRule?.(rule);
    }

    // Normalize 'always-*' to one-shot for the caller.
    return decision === 'always-allow' ? 'allow' : decision === 'always-deny' ? 'deny' : decision;
  }
}

// ── Auto-allow gate (for tests / headless mode) ──────────────────────

/**
 * A gate that auto-allows everything except critical (blocked) calls.
 * Useful for tests and headless CLI mode where no UI is available.
 */
export class AutoAllowGate implements IConfirmationGate {
  async confirm(invocation: ToolInvocation): Promise<Decision> {
    const classification = classifyToolCall(invocation.toolName, invocation.args);
    return classification.blocked ? 'deny' : 'allow';
  }
}
