// Agent Pipeline Types — shared between AgentCore and AgentLoop.
//
// The pipeline extracts the common pre-analysis flow:
//   Discovery → TaskUnderstanding → SkillSelection → ComplexityEstimation
//   → ArchitectureReview → ChangeImpactAnalysis → Planner → ContextSetup
//
// Both AgentCore and AgentLoop delegate to AgentPipeline.run()
// so that the pre-analysis logic exists in exactly one place.

import { DiscoveryReport } from '../discovery/discovery';
import { ArchitectureReviewReport } from '../analysis/architecture-review/architecture-review';
import { ChangeImpactReport as ChangeImpactReportType } from '../analysis/change-impact/change-impact-analysis';
import { ComplexityEstimate as ComplexityEstimateType } from '../analysis/complexity/complexity-estimator';
import { TaskUnderstandingResult as TaskUnderstandingResultType } from '../analysis/task-understanding/task-understanding';
import { ExecutionPlan, IncrementalContext } from '../planner/planner';
import { SelectedSkill } from '../skills/skill-types';
import { AgentContext } from './agent-core';

// Re-export actual types so consumers don't need separate imports
export type { TaskUnderstandingResultType as TaskUnderstandingResult };
export type { ComplexityEstimateType as ComplexityEstimateResult };
export type { ChangeImpactReportType as ChangeImpactReport };

// ── Pipeline Input ────────────────────────────────────────────────────

export interface PipelineInput {
  /** The user's request text */
  userRequest: string;

  /** Session ID for planner and memory */
  sessionId: string;

  /** Editor context (current file, open files, diagnostics, etc.) */
  editorContext: AgentContext;

  /** Optional callback for streaming progress messages to the user */
  onProgress?: (message: string) => void;
}

// ── Pipeline Output ───────────────────────────────────────────────────

export interface PipelineOutput {
  /** Discovery report (may be undefined if discovery failed or was skipped) */
  discoveryReport?: DiscoveryReport;

  /** Task understanding result */
  taskUnderstanding?: TaskUnderstandingResultType;

  /** Selected skills for this request */
  selectedSkills: SelectedSkill[];

  /** Complexity estimate */
  complexityEstimate?: ComplexityEstimateType;

  /** Architecture review report */
  architectureReview?: ArchitectureReviewReport;

  /** Change impact report */
  changeImpactReport?: ChangeImpactReportType;

  /** The execution plan created by the Planner */
  plan: ExecutionPlan;

  /** Incremental context with contextPackage and currentFile set */
  context: IncrementalContext;
}

// ── Pipeline Stage (for debugging and logging) ────────────────────────

export type PipelineStageName =
  | 'discovery'
  | 'taskUnderstanding'
  | 'skillSelection'
  | 'complexityEstimation'
  | 'architectureReview'
  | 'changeImpactAnalysis'
  | 'planning'
  | 'contextSetup';

export interface PipelineStageResult {
  stage: PipelineStageName;
  success: boolean;
  durationMs: number;
  error?: string;
}
