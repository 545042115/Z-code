import {
  RuntimeVerifier,
  VerificationResult,
  VerificationDiagnostic,
} from '../verifier/runtime-verifier';

export type FailureCategory = 'compile' | 'test' | 'lint' | 'logic' | 'unknown';

export interface FailureAnalysis {
  rootCause: string;
  affectedFiles: string[];
  severity: 'critical' | 'high' | 'medium' | 'low';
  category: FailureCategory;
  suggestedFixes: string[];
  errorPatterns: Array<{
    pattern: string;
    count: number;
    examples: string[];
  }>;
}

export type RepairActionType =
  | 'fix_type'
  | 'fix_import'
  | 'fix_test'
  | 'fix_lint'
  | 'revert_change'
  | 'add_guard'
  | 'update_interface'
  | 'refactor_logic';

export interface RepairAction {
  type: RepairActionType;
  targetFile: string;
  line?: number;
  description: string;
  confidence: 'high' | 'medium' | 'low';
}

export interface RepairPlan {
  summary: string;
  actions: RepairAction[];
  targetFiles: string[];
  priority: 'high' | 'medium' | 'low';
  estimatedComplexity: 'simple' | 'moderate' | 'complex';
}

export interface ReflectionMemory {
  failedFixes: string[];
  touchedFiles: string[];
  rootCauses: string[];
  previousPlans: string[];
}

export interface ReflectionReport {
  attempt: number;
  rawResults: VerificationResult[];
  analysis: FailureAnalysis;
  repairPlan: RepairPlan;
  memory: ReflectionMemory;
  timestamp: number;
}

export interface ReflectionProgress {
  errorCount: number;
  warningCount: number;
  failedTests: number;
  newErrors: number;
  fixedErrors: number;
}

export class ReflectionEngine {
  private memory: ReflectionMemory = {
    failedFixes: [],
    touchedFiles: [],
    rootCauses: [],
    previousPlans: [],
  };

  private previousProgress: ReflectionProgress | null = null;

  constructor(
    private readonly runtimeVerifier: RuntimeVerifier,
    private readonly maxReflectionCycles: number = 3
  ) {}

  get reflectionMemory(): ReflectionMemory {
    return { ...this.memory };
  }

  // ── 1. 验证：直接复用 RuntimeVerifier ──────────────────────────────────

  async verify(modifiedFiles: string[]): Promise<VerificationResult[]> {
    return this.runtimeVerifier.verifyPatch(modifiedFiles);
  }

  // ── 2. 分析失败根因 ────────────────────────────────────────────────────

  analyzeFailures(
    results: VerificationResult[],
    modifiedFiles: string[]
  ): FailureAnalysis {
    const allDiagnostics: VerificationDiagnostic[] = [];
    for (const r of results) {
      if (!r.skipped) {
        allDiagnostics.push(...r.diagnostics);
      }
    }

    const errors = allDiagnostics.filter((d) => d.severity === 'error');
    const warnings = allDiagnostics.filter((d) => d.severity === 'warning');

    const analysis: FailureAnalysis = {
      rootCause: '',
      affectedFiles: [],
      severity: 'low',
      category: 'unknown',
      suggestedFixes: [],
      errorPatterns: [],
    };

    // 分类：按结果优先级 compile > test > lint
    const buildResult = results.find((r) => r.type === 'build');
    const testResult = results.find((r) => r.type === 'test');
    const lintResult = results.find((r) => r.type === 'lint');

    if (buildResult && !buildResult.passed && !buildResult.skipped) {
      analysis.category = 'compile';
      analysis.severity = 'critical';
      analysis.rootCause = this.inferCompileRootCause(errors);
      analysis.suggestedFixes = ['fix_type', 'fix_import', 'update_interface'];
    } else if (testResult && !testResult.passed && !testResult.skipped) {
      analysis.category = 'test';
      analysis.severity = 'high';
      analysis.rootCause = this.inferTestRootCause(errors, testResult);
      analysis.suggestedFixes = ['fix_test', 'refactor_logic', 'add_guard'];
    } else if (lintResult && !lintResult.passed && !lintResult.skipped) {
      analysis.category = 'lint';
      analysis.severity = 'medium';
      analysis.rootCause = '代码风格或规范问题';
      analysis.suggestedFixes = ['fix_lint'];
    } else if (errors.length > 0) {
      analysis.category = 'logic';
      analysis.severity = 'high';
      analysis.rootCause = '存在逻辑错误或运行时异常';
      analysis.suggestedFixes = ['refactor_logic', 'add_guard'];
    }

    // 提取受影响文件
    for (const d of allDiagnostics) {
      if (d.file) analysis.affectedFiles.push(d.file);
    }
    // 加上修改过的文件（可能是间接影响）
    for (const f of modifiedFiles) {
      analysis.affectedFiles.push(f);
    }
    analysis.affectedFiles = [...new Set(analysis.affectedFiles)];

    // 错误模式聚类
    const patterns = new Map<string, string[]>();
    for (const err of errors) {
      const key = this.normalizeErrorPattern(err.message);
      if (!patterns.has(key)) patterns.set(key, []);
      patterns.get(key)!.push(err.message);
    }
    analysis.errorPatterns = Array.from(patterns.entries())
      .map(([pattern, examples]) => ({
        pattern,
        count: examples.length,
        examples: examples.slice(0, 3),
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    // 更新记忆
    this.memory.rootCauses.push(analysis.rootCause);
    for (const f of modifiedFiles) {
      if (!this.memory.touchedFiles.includes(f)) {
        this.memory.touchedFiles.push(f);
      }
    }

    return analysis;
  }

  // ── 3. 生成结构化修复计划 ──────────────────────────────────────────────

  generateRepairPlan(
    analysis: FailureAnalysis,
    originalTask: string,
    attempt: number
  ): RepairPlan {
    const actions: RepairAction[] = [];

    // 基于诊断生成结构化 Action
    for (const diag of analysis.errorPatterns.slice(0, 5)) {
      for (const example of diag.examples.slice(0, 1)) {
        const action = this.diagnosticToAction(example, analysis.category);
        if (action) actions.push(action);
      }
    }

    // 去重
    const seen = new Set<string>();
    const deduped: RepairAction[] = [];
    for (const a of actions) {
      const key = `${a.type}:${a.targetFile}:${a.line ?? 0}`;
      if (!seen.has(key)) {
        seen.add(key);
        deduped.push(a);
      }
    }

    // 根据复杂度估算
    const complexity =
      analysis.affectedFiles.length > 5
        ? 'complex'
        : analysis.affectedFiles.length > 2
          ? 'moderate'
          : 'simple';

    const plan: RepairPlan = {
      summary: `Attempt ${attempt}: ${analysis.rootCause}`,
      actions: deduped.slice(0, 10),
      targetFiles: analysis.affectedFiles.slice(0, 10),
      priority:
        analysis.severity === 'critical'
          ? 'high'
          : analysis.severity === 'high'
            ? 'high'
            : analysis.severity,
      estimatedComplexity: complexity,
    };

    // 更新记忆：避免重复计划
    const planHash = `${analysis.category}:${analysis.affectedFiles.sort().join(',')}`;
    this.memory.previousPlans.push(planHash);

    return plan;
  }

  // ── 4. 格式化修复 Prompt ───────────────────────────────────────────────

  formatRepairPrompt(
    plan: RepairPlan,
    originalTask: string,
    history: ReflectionReport[]
  ): string {
    const lines: string[] = [
      '## Reflection: Previous Attempt Failed',
      '',
      `Original task: ${originalTask}`,
      '',
      `Failure: ${plan.summary}`,
      '',
      '### Repair Actions',
    ];

    for (const action of plan.actions) {
      const loc = action.line ? `:${action.line}` : '';
      lines.push(
        `- [${action.confidence}] ${action.type} → ${action.targetFile}${loc} — ${action.description}`
      );
    }

    if (plan.targetFiles.length > 0) {
      lines.push('', '### Target Files');
      for (const f of plan.targetFiles) {
        lines.push(`- ${f}`);
      }
    }

    if (history.length > 0) {
      lines.push('', '### Previous Attempts');
      for (const h of history.slice(-2)) {
        lines.push(
          `- Attempt ${h.attempt}: ${h.analysis.category} — ${h.analysis.rootCause} (${h.repairPlan.actions.length} actions)`
        );
      }
    }

    // 注入记忆：避免重复失败
    if (this.memory.failedFixes.length > 0) {
      lines.push('', '### Avoid These Failed Approaches');
      for (const ff of this.memory.failedFixes.slice(-5)) {
        lines.push(`- ${ff}`);
      }
    }

    lines.push(
      '',
      'Please fix the issues above. Focus on the root cause, not symptoms.',
      'After fixing, ensure all build, tests, and lint pass.'
    );

    return lines.join('\n');
  }

  // ── 5. 判断是否应继续反射 ──────────────────────────────────────────────

  shouldContinueReflection(
    currentResults: VerificationResult[],
    attempt: number
  ): boolean {
    if (attempt >= this.maxReflectionCycles) {
      return false;
    }

    const currentProgress = this.computeProgress(currentResults);

    // 首次失败，允许继续
    if (!this.previousProgress) {
      this.previousProgress = currentProgress;
      return true;
    }

    const prev = this.previousProgress;
    const curr = currentProgress;

    // 若错误数减少或测试通过数增加，认为有进展，继续
    const errorImproved = curr.errorCount < prev.errorCount;
    const warningImproved = curr.warningCount < prev.warningCount;
    const testImproved = curr.failedTests < prev.failedTests;
    const hasNewFixes = curr.fixedErrors > 0;

    const isImproving = errorImproved || testImproved || hasNewFixes;

    // 连续两轮无改善则停止
    if (!isImproving && attempt >= 2) {
      console.log(
        `[ReflectionEngine] Stopping: no improvement from attempt ${attempt - 1} to ${attempt}`
      );
      return false;
    }

    this.previousProgress = currentProgress;
    return true;
  }

  // ── 6. 记录失败的修复方式 ──────────────────────────────────────────────

  recordFailedFix(plan: RepairPlan): void {
    for (const action of plan.actions) {
      const fixKey = `${action.type}:${action.targetFile}`;
      if (!this.memory.failedFixes.includes(fixKey)) {
        this.memory.failedFixes.push(fixKey);
      }
    }
  }

  // ── 内部工具 ───────────────────────────────────────────────────────────

  private inferCompileRootCause(errors: VerificationDiagnostic[]): string {
    if (errors.length === 0) return '编译失败';
    const first = errors[0].message.toLowerCase();
    if (first.includes('cannot find module') || first.includes('cannot resolve')) {
      return '模块导入路径错误或依赖缺失';
    }
    if (first.includes('is not assignable') || first.includes('type') || first.includes('interface')) {
      return '类型不匹配或接口定义变更';
    }
    if (first.includes('property') && first.includes('does not exist')) {
      return '访问了不存在的属性或方法';
    }
    if (first.includes('expected') || first.includes('argument')) {
      return '函数参数或返回值类型错误';
    }
    return '编译错误（语法或类型问题）';
  }

  private inferTestRootCause(errors: VerificationDiagnostic[], testResult: VerificationResult): string {
    if (testResult.stderr?.includes('timeout')) {
      return '测试超时（可能存在死循环或异步等待问题）';
    }
    if (testResult.stderr?.includes('assertion') || testResult.stdout?.includes('assertion')) {
      return '测试断言失败（逻辑行为不符合预期）';
    }
    if (errors.length > 0) {
      return '测试执行报错（运行时异常）';
    }
    return '测试失败';
  }

  private normalizeErrorPattern(message: string): string {
    return message
      .replace(/['"`][^'"`]+['"`]/g, "'X'")
      .replace(/\d+/g, '#')
      .replace(/\s+/g, ' ')
      .trim()
      .substring(0, 60);
  }

  private diagnosticToAction(
    message: string,
    category: FailureCategory
  ): RepairAction | null {
    const lower = message.toLowerCase();
    let type: RepairActionType = 'refactor_logic';
    let confidence: 'high' | 'medium' | 'low' = 'medium';

    if (category === 'compile') {
      if (lower.includes('cannot find module') || lower.includes('cannot resolve')) {
        type = 'fix_import';
        confidence = 'high';
      } else if (lower.includes('is not assignable') || lower.includes('type') || lower.includes('expected')) {
        type = 'fix_type';
        confidence = 'high';
      } else if (lower.includes('does not exist')) {
        type = 'update_interface';
        confidence = 'medium';
      }
    } else if (category === 'test') {
      if (lower.includes('assertion') || lower.includes('expect')) {
        type = 'fix_test';
        confidence = 'high';
      } else if (lower.includes('null') || lower.includes('undefined')) {
        type = 'add_guard';
        confidence = 'high';
      } else {
        type = 'refactor_logic';
        confidence = 'medium';
      }
    } else if (category === 'lint') {
      type = 'fix_lint';
      confidence = 'high';
    }

    return {
      type,
      targetFile: '',
      description: message.substring(0, 120),
      confidence,
    };
  }

  private computeProgress(results: VerificationResult[]): ReflectionProgress {
    let errorCount = 0;
    let warningCount = 0;
    let failedTests = 0;

    for (const r of results) {
      if (r.skipped) continue;
      for (const d of r.diagnostics) {
        if (d.severity === 'error') errorCount++;
        if (d.severity === 'warning') warningCount++;
      }
      if (r.type === 'test' && !r.passed) {
        failedTests++;
      }
    }

    const prev = this.previousProgress;
    const newErrors = prev ? Math.max(0, errorCount - prev.errorCount) : 0;
    const fixedErrors = prev ? Math.max(0, prev.errorCount - errorCount) : 0;

    return { errorCount, warningCount, failedTests, newErrors, fixedErrors };
  }
}
