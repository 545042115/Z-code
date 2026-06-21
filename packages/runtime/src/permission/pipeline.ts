// @z-assistant/runtime — Tool Invocation Pipeline (P1-2 HITL)
//
// Centralises the full tool-call lifecycle so every invocation follows the
// same path regardless of whether it originates from the chat-agent's native
// loop or the V2 Orchestrator:
//
//   classify risk → scan for prompt injection → confirmation gate →
//   dry-run or execute → audit outcome → return tool result

import type { IConfirmationGate, ToolInvocation, ToolResult, RiskLevel } from '@z-assistant/contracts';
import type { AuditLogger } from '../audit/logger';
import { DryRunExecutor } from './dry-run';
import { PromptInjectionDetector } from './prompt-injection';
import { classifyToolCall, type ToolRiskRule } from './risk-levels';
import { checkPath, extractFilePaths, type PathGuardOptions } from './path-guard';

export interface ToolInvocationPipelineOptions {
  /** Optional confirmation gate (HITL). */
  confirmationGate?: IConfirmationGate;
  /** Optional dry-run executor (HITL). */
  dryRunExecutor?: DryRunExecutor;
  /** Optional audit logger. */
  auditLogger?: AuditLogger;
  /** Optional custom risk rules; defaults used if omitted. */
  riskRules?: ToolRiskRule[];
  /** Optional run id for audit correlation. */
  runId?: string;
  /** Optional user id for audit. */
  userId?: string;
  /**
   * Optional path guard (sandbox layer 2). When provided, file-system-related
   * tool args are checked against allowed roots before execution.
   */
  pathGuard?: PathGuardOptions;
  /**
   * Callback when a tool is blocked. If not provided the pipeline returns a
   * ToolResult with ok=false and code=BLOCKED_BY_USER.
   */
  onBlocked?: (inv: ToolInvocation, reason: string) => void;
}

export interface PipelineInvocationResult extends ToolResult {
  /** Risk level computed for this invocation. */
  risk?: RiskLevel;
  /** Whether the invocation was blocked before execution. */
  blocked?: boolean;
}

export type ToolExecutor = (inv: ToolInvocation) => Promise<unknown>;

/**
 * Unified tool invocation pipeline.
 *
 * All callers pass a `ToolInvocation` and an `execute` callback. The pipeline
 * handles risk classification, prompt-injection scanning, HITL gating,
 * dry-run simulation, auditing, and result coercion.
 */
export class ToolInvocationPipeline {
  private readonly detector: PromptInjectionDetector;

  constructor(private readonly opts: ToolInvocationPipelineOptions = {}) {
    this.detector = new PromptInjectionDetector({ blockThreshold: 0.6 });
  }

  /**
   * Execute one tool invocation through the full pipeline.
   *
   * @param inv The tool invocation (id, toolName, args).
   * @param execute A callback that performs the real tool execution. Not called
   *   if the invocation is blocked or dry-run mode is active.
   */
  async invoke(inv: ToolInvocation, execute: ToolExecutor): Promise<PipelineInvocationResult> {
    const t0 = Date.now();
    const { toolName, args } = inv;

    // 1. Risk classification.
    const classification = classifyToolCall(toolName, args, this.opts.riskRules);
    const risk = classification.risk;

    // Critical-risk calls are blocked immediately, mirroring ConfirmationGate
    // behaviour where critical requests are denied without UI.
    if (risk === 'critical') {
      const reason = classification.warning ?? `Critical risk tool call blocked: ${toolName}`;
      this.opts.onBlocked?.(inv, reason);
      await this.audit('deny', inv, risk, reason);
      return {
        ok: false,
        error: { code: 'BLOCKED_RISK', message: reason },
        metrics: { durationMs: Date.now() - t0 },
        risk,
        blocked: true,
      };
    }

    // 1b. Path guard: file-system tools must stay inside allowed roots.
    if (this.opts.pathGuard) {
      const paths = extractFilePaths(args);
      for (const p of paths) {
        const { allowed, normalized } = checkPath(p, this.opts.pathGuard);
        if (!allowed) {
          const reason = `Path outside allowed sandbox: ${p}${normalized ? ` (resolved ${normalized})` : ''}`;
          this.opts.onBlocked?.(inv, reason);
          await this.audit('deny', inv, risk, reason);
          return {
            ok: false,
            error: { code: 'BLOCKED_PATH', message: reason },
            metrics: { durationMs: Date.now() - t0 },
            risk,
            blocked: true,
          };
        }
      }
    }

    // 2. Prompt-injection scan.
    const scan = this.detector.scanArgs(args);
    if (scan.injected) {
      const reason = `Prompt injection detected: ${scan.matches.map((m) => m.type).join(', ')}`;
      this.opts.onBlocked?.(inv, reason);
      await this.audit('deny', inv, risk, reason);
      return {
        ok: false,
        error: { code: 'BLOCKED_PROMPT_INJECTION', message: reason },
        metrics: { durationMs: Date.now() - t0 },
        risk,
        blocked: true,
      };
    }

    // 3. Confirmation gate.
    if (this.opts.confirmationGate) {
      const decision = await this.opts.confirmationGate.confirm(inv);
      if (decision === 'deny') {
        const reason = `Blocked by user (tool: ${toolName}).`;
        this.opts.onBlocked?.(inv, reason);
        await this.audit('deny', inv, risk, reason);
        return {
          ok: false,
          error: { code: 'BLOCKED_BY_USER', message: reason },
          metrics: { durationMs: Date.now() - t0 },
          risk,
          blocked: true,
        };
      }
      await this.audit('allow', inv, risk);
    }

    // 4. Dry-run or execute.
    try {
      const output = this.opts.dryRunExecutor
        ? await this.opts.dryRunExecutor.simulate(inv)
        : await execute(inv);
      const durationMs = Date.now() - t0;
      await this.auditOutcome(inv, risk, output, undefined, durationMs);
      return {
        ok: true,
        output,
        metrics: { durationMs },
        risk,
        blocked: false,
      };
    } catch (e: unknown) {
      const durationMs = Date.now() - t0;
      const message = e instanceof Error ? e.message : String(e);
      await this.auditOutcome(inv, risk, undefined, message, durationMs);
      return {
        ok: false,
        error: { code: 'TOOL_ERROR', message },
        metrics: { durationMs },
        risk,
        blocked: false,
      };
    }
  }

  private async audit(
    decision: 'allow' | 'deny',
    inv: ToolInvocation,
    risk: RiskLevel,
    _reason?: string,
  ): Promise<void> {
    await this.opts.auditLogger?.logPending({
      runId: this.opts.runId,
      invocationId: inv.id,
      toolName: inv.toolName,
      args: inv.args,
      risk,
      decision,
      blocked: decision === 'deny',
      userId: this.opts.userId,
    });
  }

  private async auditOutcome(
    inv: ToolInvocation,
    risk: RiskLevel,
    _output?: unknown,
    errorMessage?: string,
    durationMs?: number,
  ): Promise<void> {
    await this.opts.auditLogger?.logOutcome({
      runId: this.opts.runId,
      invocationId: inv.id,
      toolName: inv.toolName,
      args: inv.args,
      risk,
      outcome: errorMessage ? 'error' : 'success',
      errorMessage,
      durationMs,
      userId: this.opts.userId,
    });
  }
}
