// Architecture Review Phase - Analyzes whether structural changes are needed
// (function splitting, class extraction, module decomposition) before planning.

import { DiscoveryReport } from '../../discovery/discovery';
import { TaskType, TaskUnderstandingResult } from '../task-understanding/task-understanding';

export type ArchitectureSuggestionType =
  | 'split_function'
  | 'extract_class'
  | 'add_module'
  | 'move_to_file'
  | 'preserve_interface'
  | 'update_references'
  | 'add_tests';

export interface ArchitectureSuggestion {
  type: ArchitectureSuggestionType;
  targetFile: string;
  description: string;
  priority: 'high' | 'medium' | 'low';
}

export interface ArchitectureReviewReport {
  shouldSplitFunction: boolean;
  shouldExtractClass: boolean;
  shouldAddNewFile: boolean;
  shouldUpdateReferences: boolean;
  violatesSingleResponsibility: boolean;
  suggestions: ArchitectureSuggestion[];
  recommendedFiles: string[];
  rationale: string;
}

/**
 * Architecture Review runs after Discovery and before Planning.
 *
 * It inspects the DiscoveryReport (impact surface, risk analysis, scope)
 * combined with the TaskUnderstandingResult (task type, constraints)
 * to decide whether the agent should restructure code BEFORE implementing
 * the user request.
 */
export class ArchitectureReview {
  /**
   * Main entry point.
   */
  review(
    discoveryReport: DiscoveryReport,
    taskUnderstanding: TaskUnderstandingResult
  ): ArchitectureReviewReport {
    const suggestions: ArchitectureSuggestion[] = [];
    let shouldSplitFunction = false;
    let shouldExtractClass = false;
    let shouldAddNewFile = false;
    let shouldUpdateReferences = false;
    let violatesSingleResponsibility = false;
    const recommendedFiles: string[] = [];
    const rationaleParts: string[] = [];

    const { taskType, constraints, primaryTarget } = taskUnderstanding;
    const { impactSurface, riskAnalysis, scopeEstimate, involvedFiles } = discoveryReport;

    // ── Task-type driven heuristics ─────────────────────────────────────

    switch (taskType) {
      case 'replace': {
        shouldUpdateReferences = true;
        shouldAddNewFile = constraints.requireNewFile || constraints.preserveOldImpl;

        if (constraints.requireNewFile && primaryTarget) {
          suggestions.push({
            type: 'move_to_file',
            targetFile: primaryTarget,
            description: `Create new implementation file(s) rather than editing ${this.basename(primaryTarget)} in-place.`,
            priority: 'high',
          });
          rationaleParts.push('REPLACE task with explicit new-file constraint');
        }

        if (constraints.preserveInterface) {
          suggestions.push({
            type: 'preserve_interface',
            targetFile: primaryTarget || involvedFiles[0]?.path || '',
            description: 'Keep existing public signatures unchanged; swap internal implementation only.',
            priority: 'high',
          });
          rationaleParts.push('interface preservation required');
        }

        // REPLACE often means the old implementation is large / complex
        if (scopeEstimate.estimatedLines > 200) {
          shouldSplitFunction = true;
          rationaleParts.push('large implementation suggests function-level decomposition');
        }
        break;
      }

      case 'refactor': {
        shouldSplitFunction = scopeEstimate.estimatedLines > 150;
        shouldExtractClass = impactSurface.affectedFiles.length > 5;
        violatesSingleResponsibility = riskAnalysis.complexityScore > 60;

        if (shouldSplitFunction) {
          suggestions.push({
            type: 'split_function',
            targetFile: primaryTarget || involvedFiles[0]?.path || '',
            description: 'Function exceeds reasonable length; extract sub-functions with single responsibilities.',
            priority: 'high',
          });
        }

        if (shouldExtractClass) {
          suggestions.push({
            type: 'extract_class',
            targetFile: primaryTarget || involvedFiles[0]?.path || '',
            description: 'High cross-file impact suggests a new abstraction/class is needed to encapsulate logic.',
            priority: 'high',
          });
        }

        if (violatesSingleResponsibility) {
          suggestions.push({
            type: 'add_module',
            targetFile: primaryTarget || involvedFiles[0]?.path || '',
            description: 'Complexity score indicates multiple responsibilities; split into cohesive modules.',
            priority: 'medium',
          });
        }
        rationaleParts.push('explicit refactoring request');
        break;
      }

      case 'migrate': {
        shouldUpdateReferences = true;
        shouldAddNewFile = true;
        suggestions.push({
          type: 'add_module',
          targetFile: primaryTarget || involvedFiles[0]?.path || '',
          description: 'Migration typically requires a compatibility layer or new adapter module.',
          priority: 'high',
        });
        rationaleParts.push('migration requires structural adapter');
        break;
      }

      case 'create': {
        shouldAddNewFile = true;
        if (scopeEstimate.estimatedFiles > 3) {
          suggestions.push({
            type: 'add_module',
            targetFile: '',
            description: 'Multi-file creation should follow existing module conventions.',
            priority: 'medium',
          });
        }
        rationaleParts.push('creation task');
        break;
      }

      case 'modify': {
        // For modifications, only suggest structural changes if the file is risky or large
        if (riskAnalysis.highRiskFiles.length > 0) {
          shouldExtractClass = impactSurface.affectedFiles.length > 8;
          if (shouldExtractClass) {
            suggestions.push({
              type: 'extract_class',
              targetFile: riskAnalysis.highRiskFiles[0].path,
              description: 'High-risk file with many dependents; extract logic to reduce blast radius.',
              priority: 'medium',
            });
          }
        }
        if (scopeEstimate.estimatedLines > 300) {
          shouldSplitFunction = true;
          suggestions.push({
            type: 'split_function',
            targetFile: primaryTarget || involvedFiles[0]?.path || '',
            description: 'Large modification scope; consider splitting to keep functions focused.',
            priority: 'medium',
          });
        }
        rationaleParts.push('modification task with risk analysis');
        break;
      }

      case 'analyze': {
        // No structural changes for pure analysis
        rationaleParts.push('analysis task, no structural changes suggested');
        break;
      }
    }

    // ── Cross-cutting heuristics ────────────────────────────────────────

    // If many files are affected, we likely need to update references
    if (impactSurface.directImpactCount + impactSurface.indirectImpactCount > 10) {
      shouldUpdateReferences = true;
      if (!suggestions.some(s => s.type === 'update_references')) {
        suggestions.push({
          type: 'update_references',
          targetFile: '',
          description: `Wide impact surface (${impactSurface.directImpactCount} direct + ${impactSurface.indirectImpactCount} indirect) requires careful reference updates.`,
          priority: 'high',
        });
      }
    }

    // If no test coverage, recommend adding tests
    const untestedFiles = riskAnalysis.testCoverage.filter(t => !t.hasTests);
    if (untestedFiles.length > 0 && taskType !== 'analyze') {
      suggestions.push({
        type: 'add_tests',
        targetFile: untestedFiles.map(t => t.file).join(', '),
        description: `Untested files involved (${untestedFiles.length}); add tests before structural changes.`,
        priority: 'medium',
      });
    }

    // Build recommended file list
    if (shouldAddNewFile && primaryTarget) {
      const base = primaryTarget.replace(/\.[^.]+$/, '');
      const ext = primaryTarget.match(/\.[^.]+$/)?.[0] || '';
      recommendedFiles.push(`${base}_new${ext}`);
    }
    for (const s of suggestions) {
      if (s.targetFile && !recommendedFiles.includes(s.targetFile)) {
        recommendedFiles.push(s.targetFile);
      }
    }

    return {
      shouldSplitFunction,
      shouldExtractClass,
      shouldAddNewFile,
      shouldUpdateReferences,
      violatesSingleResponsibility,
      suggestions,
      recommendedFiles,
      rationale: rationaleParts.join('; ') || 'no structural concerns detected',
    };
  }

  /**
   * Formats the review report into a concise prompt fragment for the Planner.
   */
  formatForPrompt(report: ArchitectureReviewReport): string {
    const parts: string[] = [];
    parts.push('## Architecture Review');
    parts.push(`Rationale: ${report.rationale}`);
    parts.push('');

    const flags = [];
    if (report.shouldSplitFunction) { flags.push('  - Split large functions'); }
    if (report.shouldExtractClass) { flags.push('  - Extract new class/module'); }
    if (report.shouldAddNewFile) { flags.push('  - Add new file(s)'); }
    if (report.shouldUpdateReferences) { flags.push('  - Update cross-file references'); }
    if (report.violatesSingleResponsibility) { flags.push('  - Violates Single Responsibility Principle'); }

    if (flags.length > 0) {
      parts.push('Flags:');
      parts.push(...flags);
      parts.push('');
    }

    if (report.suggestions.length > 0) {
      parts.push('Suggestions:');
      for (const s of report.suggestions) {
        const icon = s.priority === 'high' ? '🔴' : s.priority === 'medium' ? '🟡' : '🟢';
        parts.push(`  ${icon} [${s.type}] ${s.description} (${s.targetFile || 'general'})`);
      }
      parts.push('');
    }

    if (report.recommendedFiles.length > 0) {
      parts.push('Recommended Files:');
      for (const f of report.recommendedFiles) {
        parts.push(`  - ${f}`);
      }
    }

    return parts.join('\n');
  }

  private basename(path: string): string {
    return path.replace(/\\/g, '/').split('/').pop() || path;
  }
}
