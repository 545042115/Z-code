// Complexity Estimator - Evaluates task complexity to choose Fast Path or Full Path.
//
// Fast Path (LOW):  Skip Architecture Review + Change Impact Analysis
// Full Path (HIGH): Run Architecture Review → Change Impact Analysis → Planner

import { TaskType, TaskUnderstandingResult } from '../task-understanding/task-understanding';

export type ComplexityLevel = 'low' | 'medium' | 'high';

export interface ComplexityEstimate {
  level: ComplexityLevel;
  confidence: number;           // 0.0 - 1.0
  reasoning: string;            // Human-readable rationale
  fastPathEligible: boolean;    // true when level === 'low'
}

/**
 * Estimates task complexity based on:
 * 1. Task type (CREATE / MODIFY / REFACTOR / REPLACE / MIGRATE / ANALYZE)
 * 2. Number of target files mentioned
 * 3. Keyword heuristics in the user request
 */
export class ComplexityEstimator {
  /**
   * Main entry point.
   */
  estimate(
    request: string,
    taskUnderstanding: TaskUnderstandingResult
  ): ComplexityEstimate {
    const lower = request.toLowerCase();
    const taskType = taskUnderstanding.taskType;
    const targetCount = this.countTargets(taskUnderstanding);

    // ── HIGH complexity indicators ────────────────────────────────────────
    const highIndicators = [
      'refactor', '重构', '重构为', '重构到',
      'migrate', '迁移', '迁移到', 'migration',
      'replace', '替换实现', '替换为', 'rewrite',
      'database', '数据库', 'schema', '表结构',
      'cross-module', '跨模块', '跨服务',
      'architecture', '架构调整', '重新设计',
      'extract class', '抽取类', '拆分类',
      'split module', '拆分模块', '拆包',
      'dependency injection', '依赖注入',
      'microservice', '微服务',
    ];

    const hasHighKeyword = highIndicators.some(k => lower.includes(k));
    const isHighType = taskType === 'refactor' || taskType === 'replace' || taskType === 'migrate';

    if (isHighType || hasHighKeyword || targetCount > 3) {
      return {
        level: 'high',
        confidence: isHighType ? 0.95 : hasHighKeyword ? 0.85 : 0.7,
        reasoning: `Task type "${taskType}" with ${targetCount} target(s). ` +
          (hasHighKeyword ? 'High-complexity keywords detected. ' : '') +
          'Full Path required: Architecture Review + Change Impact Analysis.',
        fastPathEligible: false,
      };
    }

    // ── LOW complexity indicators ─────────────────────────────────────────
    const lowIndicators = [
      'explain', '解释', '说明',
      'comment', '注释',
      'rename', '重命名', '改名', '变量名',
      'typo', '拼写错误', '错别字',
      'fix bug', '修bug', '小bug', '修复一个小',
      'simple', '简单',
      'add log', '加日志', '打印日志',
      'add type', '加类型', '类型注解',
      'format', '格式化', '代码格式',
      'one line', '一行', '单行',
      'constant', '常量', 'magic number',
    ];

    const hasLowKeyword = lowIndicators.some(k => lower.includes(k));
    const isLowType = taskType === 'analyze';
    const isSingleFileModify = taskType === 'modify' && targetCount === 1;
    const isSingleFileCreate = taskType === 'create' && targetCount === 1;

    if ((isLowType || isSingleFileModify || isSingleFileCreate) && (hasLowKeyword || targetCount <= 1)) {
      return {
        level: 'low',
        confidence: hasLowKeyword ? 0.9 : 0.75,
        reasoning: `Task type "${taskType}" with ${targetCount} target(s). ` +
          (hasLowKeyword ? 'Low-complexity keywords detected. ' : '') +
          'Fast Path eligible: skip Architecture Review and Change Impact Analysis.',
        fastPathEligible: true,
      };
    }

    // ── MEDIUM (default) ──────────────────────────────────────────────────
    return {
      level: 'medium',
      confidence: 0.6,
      reasoning: `Task type "${taskType}" with ${targetCount} target(s). ` +
        'No strong complexity signals. Using Full Path for safety.',
      fastPathEligible: false,
    };
  }

  /**
   * Format complexity estimate as a concise string for logging / UI streaming.
   */
  format(estimate: ComplexityEstimate): string {
    const icon = estimate.level === 'low' ? '🟢' : estimate.level === 'medium' ? '🟡' : '🔴';
    const pathLabel = estimate.fastPathEligible ? 'Fast Path' : 'Full Path';
    return `${icon} 复杂度: ${estimate.level.toUpperCase()} (${pathLabel}, ${Math.round(estimate.confidence * 100)}% 置信度)`;
  }

  /**
   * Inject complexity guidance into the Planner prompt.
   */
  buildPromptInjection(estimate: ComplexityEstimate): string {
    if (estimate.fastPathEligible) {
      return `## Task Complexity: LOW (Fast Path)
This is a lightweight task. Focus on precision and minimal changes.
- Prefer local edits (replace_text / insert_before / insert_after) over write_file
- Skip deep architectural analysis
- Verify quickly with targeted checks only
`;
    }
    return `## Task Complexity: ${estimate.level.toUpperCase()} (Full Path)
This is a ${estimate.level}-complexity task requiring thorough analysis.
- Follow the full workflow: understand → plan → execute → verify
- Pay attention to cross-file references and dependencies
- Ensure tests pass and no regressions are introduced
`;
  }

  private countTargets(taskUnderstanding: TaskUnderstandingResult): number {
    let count = 0;
    if (taskUnderstanding.primaryTarget) count++;
    count += taskUnderstanding.secondaryTargets.length;
    return count;
  }
}
