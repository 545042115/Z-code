// Task Understanding Module - Classifies user requests into structured task types
// to drive differentiated planning templates.

import { DiscoveryReport } from '../discovery/discovery';

export type TaskType = 'create' | 'modify' | 'refactor' | 'replace' | 'migrate' | 'analyze';

export interface TaskConstraints {
  avoidFiles: string[];            // Files that must NOT be modified
  requireNewFile: boolean;         // User explicitly wants a new file
  preserveOldImpl: boolean;        // Old implementation must be kept (e.g., A/B swap)
  preserveInterface: boolean;      // Public API / call sites must remain unchanged
  targetPathHint?: string;         // Suggested path for new files
}

export interface TaskUnderstandingResult {
  taskType: TaskType;
  confidence: number;              // 0.0 - 1.0
  primaryTarget?: string;          // Main file or module mentioned
  secondaryTargets: string[];      // Additional files/modules referenced
  constraints: TaskConstraints;
  reasoning: string;               // Human-readable classification rationale
}

/**
 * Analyzes raw user requests to produce a structured task understanding.
 *
 * Responsibilities:
 * 1. Detect task type (CREATE / MODIFY / REFACTOR / REPLACE / MIGRATE / ANALYZE)
 * 2. Extract constraints (e.g., "don't modify original", "create new file")
 * 3. Identify primary and secondary targets
 */
export class TaskUnderstanding {
  /**
   * Main entry point. Runs keyword + pattern analysis on the user request.
   */
  analyze(request: string, discoveryReport?: DiscoveryReport): TaskUnderstandingResult {
    const lower = request.toLowerCase();
    const { taskType, confidence, reasoning } = this.classifyTaskType(lower, request);
    const constraints = this.extractConstraints(lower, request);
    const { primaryTarget, secondaryTargets } = this.extractTargets(request, discoveryReport);

    // Cross-validation: if user says "新建一个 py 文件" but we classified as MODIFY,
    // force-upgrade to CREATE or REPLACE depending on presence of replacement keywords.
    const corrected = this.correctMisclassification(taskType, constraints, lower);

    return {
      taskType: corrected.taskType,
      confidence: Math.min(1.0, confidence + corrected.confidenceBoost),
      primaryTarget,
      secondaryTargets,
      constraints,
      reasoning: reasoning + (corrected.reasoning ? `; ${corrected.reasoning}` : ''),
    };
  }

  // ── Classification Core ───────────────────────────────────────────────

  private classifyTaskType(
    lower: string,
    original: string
  ): { taskType: TaskType; confidence: number; reasoning: string } {
    // REPLACE: highest priority because it's most often mis-classified
    const replacePatterns: [RegExp, number, string][] = [
      [/替换.*实现|替换.*为|改为.*实现|改成.*实现|用.*替代|用.*替换|替换.*算法|替换.*逻辑|不要.*原文件.*实现|不在.*原文件.*实现|新.*替换.*旧/i, 0.95, 'explicit replacement wording'],
      [/把.*改为|把.*改成|将.*改为|将.*改成|从.*改为/i, 0.90, 'transformation wording'],
      [/重写.*实现|重新实现|手写.*实现|自己实现/i, 0.88, 're-implementation request'],
    ];

    for (const [pattern, conf, reason] of replacePatterns) {
      if (pattern.test(original)) {
        return { taskType: 'replace', confidence: conf, reasoning: reason };
      }
    }

    // MIGRATE
    const migratePatterns: [RegExp, number, string][] = [
      [/迁移|migrate|upgrade|move to|port to|从.*迁移到|升级到|迁移至/i, 0.92, 'migration wording'],
    ];
    for (const [pattern, conf, reason] of migratePatterns) {
      if (pattern.test(original)) {
        return { taskType: 'migrate', confidence: conf, reasoning: reason };
      }
    }

    // REFACTOR
    const refactorPatterns: [RegExp, number, string][] = [
      [/重构|refactor|拆分函数|拆分.*类|抽取类|抽取函数|提取类|提取函数|解耦|模块化|单一职责|clean up|restructure/i, 0.93, 'refactoring wording'],
      [/太长|过于复杂|职责过多|god class|spaghetti/i, 0.85, 'code smell hint'],
    ];
    for (const [pattern, conf, reason] of refactorPatterns) {
      if (pattern.test(original)) {
        return { taskType: 'refactor', confidence: conf, reasoning: reason };
      }
    }

    // CREATE
    const createPatterns: [RegExp, number, string][] = [
      [/新建|创建|新增文件|create a new|new file|add a new|implement a new/i, 0.92, 'creation wording'],
      [/写一个.*文件|新建一个.*文件|添加.*文件/i, 0.90, 'file creation wording'],
    ];
    for (const [pattern, conf, reason] of createPatterns) {
      if (pattern.test(original)) {
        return { taskType: 'create', confidence: conf, reasoning: reason };
      }
    }

    // ANALYZE
    const analyzePatterns: [RegExp, number, string][] = [
      [/分析|explain|介绍|理解|说明|什么是|怎么看|如何工作|about this|project overview/i, 0.90, 'analysis wording'],
      [/项目结构|目录结构|架构|依赖关系|调用链/i, 0.88, 'architecture inquiry'],
    ];
    for (const [pattern, conf, reason] of analyzePatterns) {
      if (pattern.test(original)) {
        return { taskType: 'analyze', confidence: conf, reasoning: reason };
      }
    }

    // MODIFY (default fallback for most coding tasks)
    const modifyPatterns: [RegExp, number, string][] = [
      [/修改|更新|change|update|fix|修复|调整|优化.*性能|加|添|删/i, 0.80, 'modification wording'],
    ];
    for (const [pattern, conf, reason] of modifyPatterns) {
      if (pattern.test(original)) {
        return { taskType: 'modify', confidence: conf, reasoning: reason };
      }
    }

    // Default
    return { taskType: 'modify', confidence: 0.60, reasoning: 'default fallback to modify' };
  }

  // ── Constraint Extraction ─────────────────────────────────────────────

  private extractConstraints(lower: string, original: string): TaskConstraints {
    const avoidFiles: string[] = [];
    let requireNewFile = false;
    let preserveOldImpl = false;
    let preserveInterface = false;
    let targetPathHint: string | undefined;

    // Detect "don't implement in original file"
    if (/不要.*原文件.*实现|不要.*原文件.*写|不在.*原文件.*实现|不在.*原文件.*写|别.*原文件|另起.*文件|新建.*实现/i.test(original)) {
      requireNewFile = true;
      preserveOldImpl = true;
    }

    // Detect explicit new-file requests
    if (/新建.*文件|创建.*文件|new file|新的文件|另建.*文件/i.test(original)) {
      requireNewFile = true;
    }

    // Detect "keep old / preserve backward compatibility"
    if (/保留.*旧|兼容|backward compat|preserve.*old|保持.*现有/i.test(original)) {
      preserveOldImpl = true;
      preserveInterface = true;
    }

    // Detect "keep interface unchanged"
    if (/保持.*接口|接口.*不变|调用.*不变|不改变.*签名|signature.*same/i.test(original)) {
      preserveInterface = true;
    }

    // Extract explicit file path hints like `image_stitcher.py` or `src/foo.ts`
    const filePathMatches = original.match(/[\w\-_\/]+\.(py|ts|js|tsx|jsx|java|go|rs|cpp|c|h|hpp)/gi);
    if (filePathMatches && filePathMatches.length > 0) {
      // The first file is usually the primary target; later ones may be hints
      if (filePathMatches.length > 1) {
        targetPathHint = filePathMatches[filePathMatches.length - 1];
      }
    }

    // Extract "avoid X" constraints
    const avoidMatch = original.match(/不要修改 ([^，。；]+)|别改 ([^，。；]+)|avoid modifying ([^，。；]+)/i);
    if (avoidMatch) {
      const file = (avoidMatch[1] || avoidMatch[2] || avoidMatch[3]).trim();
      if (file) { avoidFiles.push(file); }
    }

    return {
      avoidFiles,
      requireNewFile,
      preserveOldImpl,
      preserveInterface,
      targetPathHint,
    };
  }

  // ── Target Extraction ─────────────────────────────────────────────────

  private extractTargets(
    request: string,
    discoveryReport?: DiscoveryReport
  ): { primaryTarget?: string; secondaryTargets: string[] } {
    const fileMatches = request.match(/[\w\-_\/]+\.(py|ts|js|tsx|jsx|java|go|rs|cpp|c|h|hpp)/gi) || [];
    const uniqueFiles = [...new Set(fileMatches)];

    let primaryTarget: string | undefined;
    const secondaryTargets: string[] = [];

    if (uniqueFiles.length > 0) {
      primaryTarget = uniqueFiles[0];
      secondaryTargets.push(...uniqueFiles.slice(1));
    }

    // Enrich with discovery report if no explicit file mentioned
    if (!primaryTarget && discoveryReport && discoveryReport.involvedFiles.length > 0) {
      primaryTarget = discoveryReport.involvedFiles[0].path;
    }

    return { primaryTarget, secondaryTargets };
  }

  // ── Misclassification Correction ──────────────────────────────────────

  private correctMisclassification(
    taskType: TaskType,
    constraints: TaskConstraints,
    lower: string
  ): { taskType: TaskType; confidenceBoost: number; reasoning?: string } {
    // If user demands a new file AND mentions replacing/alternating logic, force REPLACE
    if (constraints.requireNewFile && taskType === 'create') {
      if (/替换|改为|替代|重写|手写/i.test(lower)) {
        return {
          taskType: 'replace',
          confidenceBoost: 0.10,
          reasoning: 'user wants a new file to replace existing logic',
        };
      }
    }

    // If user says "refactor" but also "replace algorithm", prefer REPLACE
    if (taskType === 'refactor' && /替换.*算法|替换.*实现|改为.*实现|用.*替代/i.test(lower)) {
      return {
        taskType: 'replace',
        confidenceBoost: 0.10,
        reasoning: 'refactoring with explicit implementation replacement',
      };
    }

    return { taskType, confidenceBoost: 0 };
  }
}
