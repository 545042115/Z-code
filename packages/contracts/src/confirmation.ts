// Confirmation & Audit Contracts — Human-in-the-Loop (P1-2).
//
// These types define the contract between the agent's tool-execution
// path and the user-facing confirmation UI. The flow is:
//
//   1. Agent wants to invoke a tool.
//   2. ConfirmationGate classifies the call → RiskLevel.
//   3. If risk is 'critical' → blocked (no UI).
//   4. If risk >= 'medium' or tool.requiresConfirmation → emit
//      ConfirmationRequest to the UI.
//   5. User responds with a Decision.
//      - 'allow' / 'deny'         → one-shot
//      - 'always-allow' / 'always-deny' → persist as a rule
//   6. AuditLogger records the call + decision + outcome.
//
// The contracts here are UI-agnostic: the same ConfirmationRequest
// can be rendered as an Electron modal (Desktop), a chat inline card
// (CLI), or a VSCode warning (extension).

import type { ToolInvocation } from './tool';

// ── Risk levels ──────────────────────────────────────────────────────

/**
 * Five-level risk classification for tool calls.
 *
 * Promoted from `computer-use.ts`'s `ActionRiskLevel` to a universal
 * scale used by every tool (not just browser/GUI automation).
 *
 *   safe     — read-only, no side effects (read_file, list_directory)
 *   low      — minor side effects, easily reversible (append_text, web_search)
 *   medium   — writes/edits, reversible with effort (write_file, replace_text)
 *   high     — shell execution, network mutations, hard to reverse (run_terminal)
 *   critical — destructive, irreversible (rm -rf, drop database, git push --force)
 *
 * 'critical' calls are blocked unconditionally; the user cannot
 * override them via 'always-allow'.
 */
export type RiskLevel = 'safe' | 'low' | 'medium' | 'high' | 'critical';

// ── Decisions ────────────────────────────────────────────────────────

/**
 * User's decision on a confirmation request.
 *
 * - 'allow' / 'deny'         — applies to this call only
 * - 'always-allow'           — persist a rule: future calls with the
 *                              same toolName (and matching args pattern)
 *                              are auto-allowed
 * - 'always-deny'            — persist a rule: future calls are auto-denied
 */
export type Decision = 'allow' | 'deny' | 'always-allow' | 'always-deny';

// ── Confirmation request ────────────────────────────────────────────

/**
 * A request for the user to confirm a tool invocation.
 *
 * Emitted by `ConfirmationGate.confirm()` when a call's risk level
 * requires user approval. The UI renders this as a modal / inline card
 * and responds with a `Decision`.
 */
export interface ConfirmationRequest {
  /** Unique id (uuid v4); used to correlate the response. */
  id: string;
  /** The tool invocation that triggered the request. */
  invocation: ToolInvocation;
  /** Classified risk level. */
  risk: RiskLevel;
  /** Human-readable explanation of why confirmation is needed. */
  reason: string;
  /** Optional preview of what the tool will do (command text, diff, URL, etc.). */
  preview?: ToolPreview;
  /** When the request was created (epoch ms). */
  createdAt: number;
}

// ── Tool preview ────────────────────────────────────────────────────

/**
 * A preview of what a tool invocation will do, shown to the user
 * before they decide.
 *
 * The `kind` field tells the UI how to render the preview:
 * - 'command'  — shell command text (monospace, syntax-highlighted)
 * - 'diff'     — unified diff for file edits
 * - 'url'      — a URL that will be navigated to
 * - 'text'     — free-form text description
 */
export interface ToolPreview {
  kind: 'command' | 'diff' | 'url' | 'text';
  /** The preview content (command string, diff text, URL, or description). */
  content: string;
  /** Optional title for the preview section. */
  title?: string;
}

// ── Risk classification result ───────────────────────────────────────

/**
 * Result of classifying a tool call's risk.
 *
 * Returned by `classifyToolCall(toolName, args)`.
 */
export interface RiskClassification {
  /** The classified risk level. */
  risk: RiskLevel;
  /** Human-readable warning shown to the user (optional). */
  warning?: string;
  /** If true, the call is blocked unconditionally (critical risk). */
  blocked: boolean;
  /** The rule that matched (for debugging / audit). */
  matchedRule?: string;
}

// ── Always-rules (persisted decisions) ───────────────────────────────

/**
 * A persisted "always" decision. When the user picks 'always-allow'
 * or 'always-deny', a rule is created so future matching calls skip
 * the confirmation UI.
 *
 * Matching is by toolName (exact) + optional args pattern (glob on
 * stringified arg values). This keeps the rule engine simple — no
 * regex, no JSONPath — just glob matching on tool name and a few
 * well-known arg keys.
 */
export interface AlwaysRule {
  /** Unique id. */
  id: string;
  /** 'always-allow' or 'always-deny'. */
  decision: Extract<Decision, 'always-allow' | 'always-deny'>;
  /** Tool name to match (exact). */
  toolName: string;
  /**
   * Optional arg patterns. Keys are arg names; values are glob
   * patterns matched against the stringified arg value.
   * Example: { command: 'git *' } matches all git commands.
   * If omitted, all calls to this tool match.
   */
  argPatterns?: Record<string, string>;
  /** When the rule was created (epoch ms). */
  createdAt: number;
  /** Optional human-readable note from the user. */
  note?: string;
}

// ── Audit log ────────────────────────────────────────────────────────

/**
 * A single audit log entry recording a tool invocation's lifecycle.
 *
 * Written by the AuditLogger at two points:
 * 1. When a confirmation decision is made (decision field set, outcome 'pending')
 * 2. After the tool executes (outcome 'success' or 'error')
 *
 * For blocked calls, outcome is 'blocked' and no execution happens.
 */
export interface AuditLogEntry {
  /** Unique id. */
  id: string;
  /** When the entry was written (epoch ms). */
  timestamp: number;
  /** The run id (from TraceManager.startRun). */
  runId?: string;
  /** The tool invocation id (correlates with Span). */
  invocationId: string;
  /** Tool name. */
  toolName: string;
  /** Tool arguments (may be redacted by policy). */
  args: Record<string, unknown>;
  /** Classified risk level. */
  risk: RiskLevel;
  /** The user's decision (undefined if no confirmation was needed). */
  decision?: Decision;
  /** The matched always-rule id, if any. */
  matchedRuleId?: string;
  /** Outcome of the call. */
  outcome: 'pending' | 'success' | 'error' | 'blocked';
  /** Error message if outcome is 'error'. */
  errorMessage?: string;
  /** Execution duration in ms (set after execution). */
  durationMs?: number;
  /** User id (for multi-user audit). */
  userId?: string;
}

// ── Confirmation gate interface ──────────────────────────────────────

/**
 * The confirmation gate that sits between the agent and tool execution.
 *
 * Implementations:
 * - `ConfirmationGate` (runtime/permission/confirmation.ts) — the real
 *   implementation with risk classification + always-rules + UI callback.
 * - Tests can inject a mock that auto-allows everything.
 */
export interface IConfirmationGate {
  /**
   * Check a tool invocation and return a decision.
   *
   * - If risk is 'critical' → returns 'deny' immediately (blocked).
   * - If an always-rule matches → returns the rule's decision.
   * - Otherwise → emits a ConfirmationRequest to the UI callback and
   *   awaits the user's decision.
   *
   * The caller (chat-agent) must not execute the tool if decision is
   * 'deny' or 'always-deny'.
   */
  confirm(invocation: ToolInvocation): Promise<Decision>;
}
