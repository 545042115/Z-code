// Reflection framework — generic types + pure utilities.
//
// Per V2_VISION §"Reflection" and ADR-0006 the reflection engine is
// a small, generic, side-effect-free utility:
//   1. Aggregate verification results (build / test / lint)
//   2. Identify a dominant failure category (compile / test / lint / logic)
//   3. Normalize error messages into stable patterns
//   4. Decide whether to continue the reflection loop
//
// All of these are pure data transforms. Agent-specific reflection
// engines (Coding's `ReflectionEngine`, Browser's) sit ON TOP of
// this framework and supply the agent-specific heuristics. Per
// ADR-0006, the agent-specific engine stays in the agent package
// (Coding → `@z-assistant/agent-coding`); this file is the
// framework part, which lives in V2.
//
// Phase 6A: framework foundation. Future work:
//   - integrate with V2 `Verifier` from `packages/runtime/evaluation`
//   - add the `reflection-cycle` agent role that consumes these reports

import type { AgentResult } from '@z-assistant/contracts';

// ── Generic data shapes ───────────────────────────────────────────────

export type FailureCategory = 'compile' | 'test' | 'lint' | 'logic' | 'unknown';
export type Severity = 'critical' | 'high' | 'medium' | 'low';

export interface VerificationDiagnostic {
  severity: 'error' | 'warning' | 'info';
  file?: string;
  line?: number;
  message: string;
  code?: string;
}

export interface VerificationResult {
  type: 'build' | 'test' | 'lint' | 'runtime';
  passed: boolean;
  skipped?: boolean;
  stdout?: string;
  stderr?: string;
  diagnostics: VerificationDiagnostic[];
  durationMs: number;
}

export interface ErrorPattern {
  pattern: string;
  count: number;
  examples: string[];
}

export interface FailureAnalysis {
  rootCause: string;
  affectedFiles: string[];
  severity: Severity;
  category: FailureCategory;
  errorPatterns: ErrorPattern[];
}

// ── Pure utilities ────────────────────────────────────────────────────

/**
 * Reduce a free-text error message to a stable pattern that is
 * identical for two messages differing only in identifiers, line
 * numbers, file paths, or quoted strings.
 */
export function normalizeErrorPattern(message: string): string {
  return message
    .toLowerCase()
    .replace(/0x[0-9a-f]+/g, '<hex>')
    .replace(/['"`][^'"`]{0,80}['"`]/g, '<q>')
    .replace(/\/[a-z0-9._<>-]{1,80}/g, '<path>')
    .replace(/[a-z]:[\\/][a-z0-9._<>-]{1,80}/g, '<path>')
    .replace(/\d+/g, '<n>')
    .replace(/[^a-z0-9\s<>_-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

/**
 * Classify the dominant failure category from a list of verification
 * results, with priority: build > test > lint > runtime > logic.
 */
export function classifyFailure(results: VerificationResult[]): FailureCategory {
  const build = results.find((r) => r.type === 'build');
  if (build && !build.passed && !build.skipped) return 'compile';
  const test = results.find((r) => r.type === 'test');
  if (test && !test.passed && !test.skipped) return 'test';
  const lint = results.find((r) => r.type === 'lint');
  if (lint && !lint.passed && !lint.skipped) return 'lint';
  const runtime = results.find((r) => r.type === 'runtime');
  if (runtime && !runtime.passed && !runtime.skipped) return 'logic';
  const hasErrors = results.some((r) =>
    r.diagnostics.some((d) => d.severity === 'error'),
  );
  return hasErrors ? 'logic' : 'unknown';
}

/**
 * Build a FailureAnalysis by aggregating diagnostics, picking the
 * dominant category, and clustering error messages by pattern.
 */
export function analyzeFailures(results: VerificationResult[]): FailureAnalysis {
  const diags: VerificationDiagnostic[] = [];
  for (const r of results) if (!r.skipped) diags.push(...r.diagnostics);
  const errors = diags.filter((d) => d.severity === 'error');
  const category = classifyFailure(results);

  // Cluster errors by pattern
  const buckets = new Map<string, string[]>();
  for (const e of errors) {
    const k = normalizeErrorPattern(e.message);
    let arr = buckets.get(k);
    if (!arr) { arr = []; buckets.set(k, arr); }
    arr.push(e.message);
  }
  const errorPatterns: ErrorPattern[] = Array.from(buckets.entries())
    .map(([pattern, examples]) => ({ pattern, count: examples.length, examples: examples.slice(0, 3) }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  const affectedFiles = [...new Set(diags.map((d) => d.file).filter((f): f is string => Boolean(f)))];

  return {
    rootCause: rootCauseForCategory(category, errors),
    affectedFiles,
    severity: severityForCategory(category, errors.length),
    category,
    errorPatterns,
  };
}

/** Decide whether to continue the reflection loop based on progress. */
export function shouldContinue(
  current: FailureAnalysis,
  prev: FailureAnalysis | null,
  attempt: number,
  maxAttempts: number,
): boolean {
  if (attempt >= maxAttempts) return false;
  if (!prev) return true;          // first failure, always allow
  const improved = current.errorPatterns.length < prev.errorPatterns.length
    || current.affectedFiles.length < prev.affectedFiles.length;
  // If we improved or we're still in early attempts, continue
  return improved || attempt < 2;
}

/**
 * Build a minimal agent-flavored reflection hint. Agent packages
 * (Coding / Browser) can call this and then layer their own
 * prompt-formatting on top.
 */
export function buildReflectionHint(args: {
  analysis: FailureAnalysis;
  originalTask: string;
  attempt: number;
}): string {
  const { analysis, originalTask, attempt } = args;
  const lines: string[] = [
    `## Reflection: Attempt ${attempt} failed`,
    '',
    `Original task: ${originalTask}`,
    '',
    `Failure: [${analysis.category}] ${analysis.rootCause}`,
    '',
  ];
  if (analysis.errorPatterns.length > 0) {
    lines.push('### Recurring Error Patterns');
    for (const p of analysis.errorPatterns) {
      lines.push(`- ${p.pattern}  (×${p.count})`);
    }
  }
  if (analysis.affectedFiles.length > 0) {
    lines.push('', '### Affected Files');
    for (const f of analysis.affectedFiles.slice(0, 10)) lines.push(`- ${f}`);
  }
  lines.push('', 'Please address the root cause, not the symptom.');
  return lines.join('\n');
}

// ── Helpers ───────────────────────────────────────────────────────────

function rootCauseForCategory(cat: FailureCategory, errors: VerificationDiagnostic[]): string {
  if (cat === 'unknown') return 'No diagnostics available';
  if (cat === 'compile') return inferCompileRootCause(errors);
  if (cat === 'test')    return 'Test assertions failed or tests did not complete';
  if (cat === 'lint')    return 'Lint or style violations';
  if (cat === 'logic')   return 'Runtime / logic error';
  return 'unknown';
}

function inferCompileRootCause(errors: VerificationDiagnostic[]): string {
  if (errors.length === 0) return 'Build failed';
  const first = errors[0].message.toLowerCase();
  if (first.includes('cannot find module') || first.includes('cannot resolve'))
    return 'Module import path missing or dependency not installed';
  if (first.includes('is not assignable') || first.includes('type')) return 'Type mismatch';
  if (first.includes('does not exist')) return 'Accessed missing property or symbol';
  if (first.includes('expected') || first.includes('argument')) return 'Function signature mismatch';
  return 'Build error';
}

function severityForCategory(cat: FailureCategory, errorCount: number): Severity {
  if (cat === 'compile') return 'critical';
  if (cat === 'test')    return 'high';
  if (cat === 'lint')    return 'medium';
  if (cat === 'logic')   return errorCount > 0 ? 'high' : 'low';
  return 'low';
}

// ── Convenience wrapper ───────────────────────────────────────────────

/** Reflect on an AgentResult + verification results, returning a hint
 *  string that the caller can prepend to the next agent prompt. */
export async function reflectOnResults(
  agent: AgentResult,
  verifications: VerificationResult[],
  attempt: number,
  maxAttempts = 3,
): Promise<{ analysis: FailureAnalysis; hint: string; shouldRetry: boolean }> {
  const analysis = analyzeFailures(verifications);
  // The caller is responsible for tracking `prev`; this minimal
  // version just decides based on the current analysis.
  const shouldRetry = shouldContinue(analysis, null, attempt, maxAttempts);
  const hint = buildReflectionHint({ analysis, originalTask: agent.output?.toString() ?? '', attempt });
  return { analysis, hint, shouldRetry };
}
