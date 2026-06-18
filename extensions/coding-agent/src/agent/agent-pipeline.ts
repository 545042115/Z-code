// Agent Pipeline — unified pre-analysis flow shared by AgentCore and AgentLoop.
//
// Extracts the common pipeline:
//   Discovery → TaskUnderstanding → SkillSelection → ComplexityEstimation
//   → ArchitectureReview → ChangeImpactAnalysis → Planner → ContextSetup
//
// This ensures both UI mode (AgentCore) and loop mode (AgentLoop) produce
// identical pre-analysis results for the same input.

import { ContextManager } from '../context/context-manager';
import { AgentContext } from './agent-core';
import {
  PipelineInput,
  PipelineOutput,
  PipelineStageResult,
  PipelineStageName,
} from './pipeline-types';
import { DiscoveryReport } from '../discovery/discovery';
import { ArchitectureReviewReport } from '../analysis/architecture-review/architecture-review';
import { ChangeImpactReport, ChangePlanInput } from '../analysis/change-impact/change-impact-analysis';
import { ComplexityEstimate } from '../analysis/complexity/complexity-estimator';
import { TaskUnderstandingResult } from '../analysis/task-understanding/task-understanding';
import { SelectedSkill } from '../skills/skill-types';
import { ExecutionPlan, IncrementalContext } from '../planner/planner';

export class AgentPipeline {

  /**
   * Run the full pre-analysis pipeline.
   *
   * Each stage is optional — if the required subsystem is not available,
   * the stage is skipped gracefully. Errors in individual stages do not
   * abort the pipeline; they are logged and the output for that stage
   * remains undefined.
   */
  async run(input: PipelineInput): Promise<PipelineOutput> {
    const { userRequest, sessionId, editorContext, onProgress } = input;
    const ctx = input.editorContext;
    const cm = this.getContextManager();
    const stageResults: PipelineStageResult[] = [];

    // ── 1. Discovery Phase ──────────────────────────────────────────
    let discoveryReport: DiscoveryReport | undefined;
    {
      const start = Date.now();
      try {
        if (cm.discoveryPhase) {
          const intent = cm.planner.classifyIntent(userRequest);
          const contextPackage = await cm.contextBuilder.build(userRequest, ctx.currentFile);
          discoveryReport = await cm.discoveryPhase.run(userRequest, contextPackage, intent);
          if (discoveryReport && onProgress) {
            onProgress(`📊 ${discoveryReport.summary}\n\n`);
          }
        }
        stageResults.push({ stage: 'discovery', success: true, durationMs: Date.now() - start });
      } catch (err) {
        console.warn('[Pipeline] Discovery phase failed:', err);
        stageResults.push({ stage: 'discovery', success: false, durationMs: Date.now() - start, error: String(err) });
      }
    }

    // ── 2. Task Understanding ───────────────────────────────────────
    let taskUnderstanding: TaskUnderstandingResult | undefined;
    {
      const start = Date.now();
      try {
        taskUnderstanding = cm.taskUnderstanding?.analyze(userRequest, discoveryReport);
        if (taskUnderstanding && onProgress) {
          onProgress(`🎯 任务类型: ${taskUnderstanding.taskType} (${Math.round(taskUnderstanding.confidence * 100)}% 置信度)\n`);
          if (taskUnderstanding.constraints.requireNewFile) {
            onProgress('📄 约束: 需要新建文件\n');
          }
          onProgress('\n');
        }
        stageResults.push({ stage: 'taskUnderstanding', success: true, durationMs: Date.now() - start });
      } catch (err) {
        console.warn('[Pipeline] Task Understanding failed:', err);
        stageResults.push({ stage: 'taskUnderstanding', success: false, durationMs: Date.now() - start, error: String(err) });
      }
    }

    // ── 3. Skill Selection ──────────────────────────────────────────
    let selectedSkills: SelectedSkill[] = [];
    {
      const start = Date.now();
      try {
        if (cm.skillManager) {
          selectedSkills = cm.skillManager.select({
            userRequest,
            taskType: taskUnderstanding?.taskType,
            currentFile: ctx.currentFile,
            openFiles: ctx.openFiles,
            discoveryReport: discoveryReport ? {
              involvedFiles: discoveryReport.involvedFiles,
              relatedSymbols: discoveryReport.relatedSymbols,
            } : undefined,
            topK: 3,
          });
          if (selectedSkills.length > 0 && onProgress) {
            onProgress(cm.skillManager.formatSummary(selectedSkills));
          }
        }
        stageResults.push({ stage: 'skillSelection', success: true, durationMs: Date.now() - start });
      } catch (err) {
        console.warn('[Pipeline] Skill Selection failed:', err);
        stageResults.push({ stage: 'skillSelection', success: false, durationMs: Date.now() - start, error: String(err) });
      }
    }

    // ── 4. Complexity Estimation ────────────────────────────────────
    let complexityEstimate: ComplexityEstimate | undefined;
    {
      const start = Date.now();
      try {
        if (cm.complexityEstimator && taskUnderstanding) {
          complexityEstimate = cm.complexityEstimator.estimate(userRequest, taskUnderstanding);
          if (onProgress) {
            onProgress(`${cm.complexityEstimator.format(complexityEstimate)}\n`);
            if (complexityEstimate.fastPathEligible) {
              onProgress('⚡ 使用 Fast Path：跳过 Architecture Review 和 Change Impact Analysis\n\n');
            } else {
              onProgress('🔍 使用 Full Path：执行完整分析流程\n\n');
            }
          }
        }
        stageResults.push({ stage: 'complexityEstimation', success: true, durationMs: Date.now() - start });
      } catch (err) {
        console.warn('[Pipeline] Complexity Estimation failed:', err);
        stageResults.push({ stage: 'complexityEstimation', success: false, durationMs: Date.now() - start, error: String(err) });
      }
    }

    // ── 5. Architecture Review ──────────────────────────────────────
    let architectureReview: ArchitectureReviewReport | undefined;
    {
      const start = Date.now();
      try {
        if (!complexityEstimate?.fastPathEligible && cm.architectureReview && discoveryReport && taskUnderstanding) {
          architectureReview = cm.architectureReview.review(discoveryReport, taskUnderstanding);
          if (architectureReview.suggestions.length > 0 && onProgress) {
            onProgress(`🏗️ 架构建议: ${architectureReview.suggestions.length} 条\n`);
            for (const s of architectureReview.suggestions.slice(0, 3)) {
              onProgress(`   ${s.priority === 'high' ? '🔴' : s.priority === 'medium' ? '🟡' : '🟢'} ${s.description}\n`);
            }
            onProgress('\n');
          }
        }
        stageResults.push({ stage: 'architectureReview', success: true, durationMs: Date.now() - start });
      } catch (err) {
        console.warn('[Pipeline] Architecture Review failed:', err);
        stageResults.push({ stage: 'architectureReview', success: false, durationMs: Date.now() - start, error: String(err) });
      }
    }

    // ── 6. Change Impact Analysis ───────────────────────────────────
    let changeImpactReport: ChangeImpactReport | undefined;
    {
      const start = Date.now();
      try {
        if (!complexityEstimate?.fastPathEligible && cm.changeImpactAnalysis && discoveryReport && taskUnderstanding) {
          const changeInput: ChangePlanInput = {
            userRequest,
            taskType: taskUnderstanding.taskType,
            taskUnderstanding,
            architectureReview: architectureReview || {
              shouldSplitFunction: false,
              shouldExtractClass: false,
              shouldAddNewFile: false,
              shouldUpdateReferences: false,
              violatesSingleResponsibility: false,
              suggestions: [],
              recommendedFiles: [],
              rationale: 'Architecture review skipped or not available',
            },
            discoveryReport,
          };
          changeImpactReport = cm.changeImpactAnalysis.analyze(changeInput);
          if (onProgress) {
            onProgress(`📊 影响分析: ${changeImpactReport.directImpactFiles.length} 个直接文件, ${changeImpactReport.indirectImpactFiles.length} 个间接文件\n`);
          }
        }
        stageResults.push({ stage: 'changeImpactAnalysis', success: true, durationMs: Date.now() - start });
      } catch (err) {
        console.warn('[Pipeline] Change Impact Analysis failed:', err);
        stageResults.push({ stage: 'changeImpactAnalysis', success: false, durationMs: Date.now() - start, error: String(err) });
      }
    }

    // ── 7. Planning ─────────────────────────────────────────────────
    let plan: ExecutionPlan;
    {
      const start = Date.now();
      try {
        plan = cm.planner.create(
          userRequest,
          sessionId,
          discoveryReport,
          taskUnderstanding,
          architectureReview,
          changeImpactReport,
          complexityEstimate,
        );

        // Execute planner steps
        for (const step of plan.steps) {
          const result = await cm.planner.executeStep(step, userRequest, sessionId, plan.context, plan.searchTerms, discoveryReport);
          if (result.status !== 'completed') {
            console.warn(`[Pipeline] Planner step failed: ${step.description}`);
          }
        }

        stageResults.push({ stage: 'planning', success: true, durationMs: Date.now() - start });
      } catch (err) {
        console.warn('[Pipeline] Planning failed:', err);
        // Create a minimal fallback plan
        plan = cm.planner.create(userRequest, sessionId);
        stageResults.push({ stage: 'planning', success: false, durationMs: Date.now() - start, error: String(err) });
      }
    }

    // ── 8. Context Setup ────────────────────────────────────────────
    const context = plan.context;
    {
      const start = Date.now();
      if (ctx.currentFile) {
        context.currentFile = ctx.currentFile;
      }
      if (discoveryReport?.contextPackage) {
        context.contextPackage = discoveryReport.contextPackage;
      }
      stageResults.push({ stage: 'contextSetup', success: true, durationMs: Date.now() - start });
    }

    // Log pipeline summary
    const failedStages = stageResults.filter(s => !s.success);
    if (failedStages.length > 0) {
      console.warn(`[Pipeline] ${failedStages.length}/${stageResults.length} stages failed: ${failedStages.map(s => s.stage).join(', ')}`);
    }

    return {
      discoveryReport,
      taskUnderstanding,
      selectedSkills,
      complexityEstimate,
      architectureReview,
      changeImpactReport,
      plan,
      context,
    };
  }

  /**
   * Get the ContextManager singleton.
   * Must be overridden or the pipeline must be constructed with a reference.
   */
  private contextManager: ContextManager | undefined;

  constructor(contextManager?: ContextManager) {
    this.contextManager = contextManager;
  }

  private getContextManager(): ContextManager {
    if (!this.contextManager) {
      throw new Error('AgentPipeline: ContextManager not set. Pass it in the constructor.');
    }
    return this.contextManager;
  }
}
