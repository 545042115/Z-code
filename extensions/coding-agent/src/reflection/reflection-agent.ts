// Reflection Agent - Condition-triggered reflection module.
// Only invoked when Verify fails or execution is abnormal.
// Responsibilities: FailureAnalysis, RootCause, RepairAction generation,
// ReflectionMemory update, and loop-continue decision.

import { ExecutionPlan } from '../planner/planner';
import { VerificationResult } from '../verifier/runtime-verifier';
import {
  ReflectionEngine,
  FailureAnalysis,
  RepairPlan,
  ReflectionMemory,
} from './reflection-engine';

/**
 * Simplified record of a tool call result for reflection input.
 */
export interface ToolResult {
  toolName: string;
  params: Record<string, any>;
  result: string;
  success: boolean;
}

/**
 * Record of a previous reflection cycle.
 */
export interface ReflectionRecord {
  attempt: number;
  rootCause: string;
  repairActions: string[];
  summary: string;
  timestamp: number;
}

/**
 * Standardized input to the Reflection Agent.
 */
export interface ReflectionInput {
  userRequest: string;
  currentPlan: ExecutionPlan;
  executionResult: string;
  toolResults: ToolResult[];
  verificationResults: VerificationResult[];
  previousReflections: ReflectionRecord[];
}

/**
 * Standardized output from the Reflection Agent.
 */
export interface ReflectionOutput {
  rootCause: string;
  repairActions: string[];
  confidence: number;
  shouldReplan: boolean;
  shouldContinue: boolean;
  reflectionSummary: string;
}

/**
 * ReflectionAgent wraps ReflectionEngine with a clean condition-triggered API.
 *
 * It is ONLY called when verification fails or execution terminates abnormally.
 * It analyzes the failure, updates memory, and decides whether to continue the loop.
 */
export class ReflectionAgent {
  private records: ReflectionRecord[] = [];

  constructor(private readonly engine: ReflectionEngine) {}

  /**
   * Main entry point. Performs failure analysis and decides next steps.
   * This method should ONLY be called when verification failed.
   */
  reflect(input: ReflectionInput): ReflectionOutput {
    const { userRequest, verificationResults, executionResult, toolResults, previousReflections } = input;

    // 1. Aggregate failure context
    const modifiedFiles = this.extractModifiedFiles(toolResults);
    const hasVerificationFailure = verificationResults.some(r => !r.passed && !r.skipped);
    const hasExecutionError = toolResults.some(t => !t.success);

    // 2. Run FailureAnalysis via ReflectionEngine
    const analysis = this.engine.analyzeFailures(verificationResults, modifiedFiles);

    // 3. Generate RepairPlan
    const attempt = previousReflections.length + 1;
    const repairPlan = this.engine.generateRepairPlan(analysis, userRequest, attempt);

    // 4. Build ReflectionRecord
    const record: ReflectionRecord = {
      attempt,
      rootCause: analysis.rootCause,
      repairActions: repairPlan.actions.map(a => `[${a.type}] ${a.targetFile} — ${a.description}`),
      summary: repairPlan.summary,
      timestamp: Date.now(),
    };
    this.records.push(record);

    // 5. Determine if we should continue / replan
    const shouldContinue = this.engine.shouldContinueReflection(verificationResults, attempt);
    const shouldReplan = hasVerificationFailure || hasExecutionError;

    // 6. Compute confidence based on severity and history
    const confidence = this.computeConfidence(analysis, previousReflections);

    // 7. Build summary
    const reflectionSummary = this.buildSummary(analysis, repairPlan, shouldContinue, shouldReplan);

    return {
      rootCause: analysis.rootCause,
      repairActions: record.repairActions,
      confidence,
      shouldReplan,
      shouldContinue,
      reflectionSummary,
    };
  }

  /**
   * Formats a repair prompt for the next loop iteration.
   */
  formatRepairPrompt(
    output: ReflectionOutput,
    userRequest: string,
    plan: ExecutionPlan,
    toolResults: ToolResult[]
  ): string {
    const lines: string[] = [
      '## Reflection: Previous Attempt Failed',
      '',
      `Original task: ${userRequest}`,
      '',
      `Root cause: ${output.rootCause}`,
      '',
      '### Reflection Summary',
      output.reflectionSummary,
      '',
    ];

    if (output.repairActions.length > 0) {
      lines.push('### Repair Actions');
      for (const action of output.repairActions) {
        lines.push(`- ${action}`);
      }
      lines.push('');
    }

    const modifiedFiles = this.extractModifiedFiles(toolResults);
    if (modifiedFiles.length > 0) {
      lines.push('### Modified Files');
      for (const f of modifiedFiles) {
        lines.push(`- ${f}`);
      }
      lines.push('');
    }

    lines.push('## Instructions');
    lines.push('Please fix the root cause identified above. Focus on the root cause, not symptoms.');
    lines.push('After fixing, ensure all build, tests, and lint pass.');

    return lines.join('\n');
  }

  /**
   * Access the underlying ReflectionMemory (for compatibility).
   */
  get reflectionMemory(): ReflectionMemory {
    return this.engine.reflectionMemory;
  }

  /**
   * Access all reflection records.
   */
  get reflectionRecords(): ReflectionRecord[] {
    return [...this.records];
  }

  // ── Internal helpers ──────────────────────────────────────────────────

  private extractModifiedFiles(toolResults: ToolResult[]): string[] {
    const files: string[] = [];
    const editTools = new Set([
      'write_file',
      'replace_text',
      'insert_before',
      'insert_after',
      'append_text',
    ]);
    for (const tr of toolResults) {
      if (editTools.has(tr.toolName) && tr.params?.filePath) {
        files.push(tr.params.filePath);
      }
    }
    return [...new Set(files)];
  }

  private computeConfidence(
    analysis: FailureAnalysis,
    previousReflections: ReflectionRecord[]
  ): number {
    let score = 0.5;

    // Severity bonus
    if (analysis.severity === 'critical') score -= 0.2;
    else if (analysis.severity === 'high') score -= 0.1;
    else if (analysis.severity === 'medium') score += 0.1;
    else score += 0.2;

    // History penalty: repeated failures reduce confidence
    const sameRootCauseCount = previousReflections.filter(
      r => r.rootCause === analysis.rootCause
    ).length;
    score -= sameRootCauseCount * 0.15;

    // Action count bonus: more specific actions = higher confidence
    score += Math.min(0.2, analysis.suggestedFixes.length * 0.05);

    return Math.max(0.0, Math.min(1.0, score));
  }

  private buildSummary(
    analysis: FailureAnalysis,
    repairPlan: RepairPlan,
    shouldContinue: boolean,
    shouldReplan: boolean
  ): string {
    const parts: string[] = [];
    parts.push(`Failure category: ${analysis.category}`);
    parts.push(`Severity: ${analysis.severity}`);
    parts.push(`Affected files: ${analysis.affectedFiles.slice(0, 5).join(', ') || 'none'}`);
    parts.push(`Repair actions: ${repairPlan.actions.length}`);
    parts.push(`Should replan: ${shouldReplan}`);
    parts.push(`Should continue: ${shouldContinue}`);
    return parts.join('; ');
  }
}
