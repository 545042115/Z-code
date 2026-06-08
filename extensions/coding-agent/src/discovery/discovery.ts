import * as vscode from 'vscode';
import { ContextPackage } from '../context/contextBuilder';
import { RepoGraph } from '../context/repoGraph';
import { DependencyGraph } from '../context/dependencyGraph';
import { WorkspaceScanner, WorkspaceFile } from '../context/workspaceScanner';
import { RepoKnowledge, RepoKnowledgeBase } from '../memory/repoKnowledgeBase';

export interface RelatedSymbol {
  name: string;
  kind: string;
  filePath: string;
  line: number;
  relation: string;
  depth: number;
  score: number;
}

export interface DiscoveredModule {
  name: string;
  tag: string;
  files: string[];
  entryPoints: string[];
  role: string;
}

export interface DiscoveredFile {
  path: string;
  role: 'primary' | 'related' | 'dependency' | 'test' | 'config';
  relevanceScore: number;
  reason: string;
  symbolCount: number;
  dependencyCount: number;
}

export interface ImpactSurface {
  affectedFiles: string[];
  affectedSymbols: RelatedSymbol[];
  directImpactCount: number;
  indirectImpactCount: number;
  riskLevel: 'low' | 'medium' | 'high';
}

export interface RiskItem {
  path: string;
  risk: 'entry_point' | 'high_dependents' | 'no_tests';
  reason: string;
}

export interface RiskAnalysis {
  highRiskFiles: RiskItem[];
  breakingChanges: Array<{
    file: string;
    symbol: string;
    affectedDependents: string[];
  }>;
  testCoverage: Array<{
    file: string;
    hasTests: boolean;
    testFiles: string[];
  }>;
  complexityScore: number;
}

export interface ScopeEstimate {
  estimatedFiles: number;
  estimatedSymbols: number;
  estimatedLines: number;
  confidence: 'low' | 'medium' | 'high';
  recommendation: string;
}

export interface DiscoveryReport {
  intent: string;
  query: string;
  summary: string;
  involvedModules: DiscoveredModule[];
  involvedFiles: DiscoveredFile[];
  relatedSymbols: RelatedSymbol[];
  impactSurface: ImpactSurface;
  riskAnalysis: RiskAnalysis;
  scopeEstimate: ScopeEstimate;
  contextPackage: ContextPackage;
  repoKnowledge?: RepoKnowledge;
  durationMs: number;
  timestamp: number;
}

export class DiscoveryPhase {
  constructor(
    private readonly repoGraph: RepoGraph,
    private readonly dependencyGraph: DependencyGraph,
    private readonly scanner: WorkspaceScanner,
    private readonly repoKnowledgeBase?: RepoKnowledgeBase
  ) {}

  async run(
    query: string,
    contextPackage: ContextPackage,
    intent: string
  ): Promise<DiscoveryReport> {
    const startTime = Date.now();

    const progressOptions = {
      location: vscode.ProgressLocation.Notification,
      title: '正在分析代码库...',
      cancellable: false,
    };

    return vscode.window.withProgress(
      progressOptions,
      async (progress) => {
        progress.report({ increment: 0, message: '分析模块结构' });

        const involvedModules = this.analyzeModules(contextPackage);

        progress.report({ increment: 25, message: '分析依赖影响面' });
        const impactSurface = this.analyzeImpactSurface(contextPackage);

        progress.report({ increment: 25, message: '评估风险' });
        const riskAnalysis = this.assessRisks(contextPackage, impactSurface);

        progress.report({ increment: 25, message: '估计修改范围' });
        const scopeEstimate = await this.estimateScope(
          contextPackage,
          impactSurface
        );

        progress.report({ increment: 25, message: '生成报告' });
        const relatedSymbols = this.extractRelatedSymbols(contextPackage);
        const involvedFiles = this.buildInvolvedFiles(
          contextPackage,
          impactSurface
        );

        const durationMs = Date.now() - startTime;
        const summary = this.buildSummary(
          scopeEstimate,
          riskAnalysis,
          impactSurface
        );

        const repoKnowledge = this.repoKnowledgeBase?.getKnowledge() || undefined;

        return {
          intent,
          query,
          summary,
          involvedModules,
          involvedFiles,
          relatedSymbols,
          impactSurface,
          riskAnalysis,
          scopeEstimate,
          contextPackage,
          repoKnowledge,
          durationMs,
          timestamp: Date.now(),
        };
      }
    );
  }

  buildMinimalReport(
    intent: string,
    query: string,
    contextPackage: ContextPackage
  ): DiscoveryReport {
    const involvedFiles = contextPackage.selectedFiles.map((path) => ({
      path,
      role: 'primary' as const,
      relevanceScore: 100,
      reason: '当前活动文件',
      symbolCount: 0,
      dependencyCount: 0,
    }));

    return {
      intent,
      query,
      summary: '快速路径：基于当前上下文的轻量分析',
      involvedModules: [],
      involvedFiles,
      relatedSymbols: [],
      impactSurface: {
        affectedFiles: contextPackage.selectedFiles,
        affectedSymbols: [],
        directImpactCount: 0,
        indirectImpactCount: 0,
        riskLevel: 'low',
      },
      riskAnalysis: {
        highRiskFiles: [],
        breakingChanges: [],
        testCoverage: [],
        complexityScore: 0,
      },
      scopeEstimate: {
        estimatedFiles: contextPackage.selectedFiles.length,
        estimatedSymbols: 0,
        estimatedLines: 0,
        confidence: 'high',
        recommendation: '范围较小，可直接执行',
      },
      contextPackage,
      durationMs: 0,
      timestamp: Date.now(),
    };
  }

  isSimpleRequest(
    intent: string,
    query: string,
    contextPackage: ContextPackage
  ): boolean {
    const complexKeywords = [
      '重构',
      '架构',
      '多文件',
      '跨文件',
      '大范围',
      '批量',
      '迁移',
    ];
    const isComplex = complexKeywords.some((kw) =>
      query.toLowerCase().includes(kw)
    );
    return (
      (['documentation', 'other'].includes(intent) &&
        query.length < 50 &&
        !isComplex) ||
      contextPackage.selectedFiles.length <= 1
    );
  }

  // ── 模块分析 ──────────────────────────────────────────────────────────
  private analyzeModules(contextPackage: ContextPackage): DiscoveredModule[] {
    // 优先从 Knowledge Base 获取模块信息
    const kbModules = this.repoKnowledgeBase?.getCoreModules();
    if (kbModules && kbModules.length > 0) {
      const involvedTags = new Set<string>();
      for (const file of contextPackage.selectedFiles) {
        involvedTags.add(this.repoGraph.getNode(file)?.moduleTag || 'other');
      }

      return kbModules
        .filter((m) => involvedTags.has(m.name) || involvedTags.has('other'))
        .slice(0, 10)
        .map((m) => ({
          name: m.name,
          tag: m.name,
          files: m.representativeFiles,
          entryPoints: [],
          role: m.description,
        }));
    }

    // 降级：原有逻辑
    const modules = new Map<string, DiscoveredModule>();

    for (const file of contextPackage.selectedFiles) {
      const tag = this.repoGraph.getNode(file)?.moduleTag || 'unknown';
      const moduleName = tag === 'unknown' ? '未分类' : tag;

      if (!modules.has(moduleName)) {
        modules.set(moduleName, {
          name: moduleName,
          tag,
          files: [],
          entryPoints: [],
          role: '',
        });
      }

      const mod = modules.get(moduleName)!;
      mod.files.push(file);

      const node = this.dependencyGraph.getNode(file);
      if (node && node.isEntryPoint) {
        mod.entryPoints.push(file);
      }
    }

    for (const mod of modules.values()) {
      if (mod.entryPoints.length > 0) {
        mod.role = '入口模块';
      } else if (mod.tag === 'core') {
        mod.role = '核心模块';
      } else if (mod.tag === 'server') {
        mod.role = '服务端模块';
      } else if (mod.tag === 'ui') {
        mod.role = 'UI 模块';
      } else if (mod.tag === 'test') {
        mod.role = '测试模块';
      } else {
        mod.role = '支持模块';
      }
    }

    return Array.from(modules.values());
  }

  // ── 影响面分析 ─────────────────────────────────────────────────────────
  private analyzeImpactSurface(contextPackage: ContextPackage): ImpactSurface {
    const affectedFiles = new Set<string>();
    const affectedSymbols: RelatedSymbol[] = [];
    let directImpactCount = 0;
    let indirectImpactCount = 0;

    for (const file of contextPackage.selectedFiles) {
      affectedFiles.add(file);

      const node = this.dependencyGraph.getNode(file);
      if (node) {
        for (const dep of node.dependencies) {
          affectedFiles.add(dep);
          directImpactCount++;
        }
        for (const dep of node.dependents) {
          affectedFiles.add(dep);
          directImpactCount++;
        }

        for (const dep of node.dependencies) {
          const depNode = this.dependencyGraph.getNode(dep);
          if (depNode) {
            for (const indirect of depNode.dependencies) {
              if (!contextPackage.selectedFiles.includes(indirect)) {
                affectedFiles.add(indirect);
                indirectImpactCount++;
              }
            }
            for (const indirect of depNode.dependents) {
              if (!contextPackage.selectedFiles.includes(indirect)) {
                affectedFiles.add(indirect);
                indirectImpactCount++;
              }
            }
          }
        }
      }
    }

    if (contextPackage.expandedNodes) {
      for (const node of contextPackage.expandedNodes) {
        affectedSymbols.push({
          name: node.symbolName,
          kind: node.kind,
          filePath: node.filePath,
          line: node.line,
          relation: node.relation,
          depth: node.depth,
          score: node.score,
        });
      }
    }

    let riskLevel: 'low' | 'medium' | 'high' = 'low';
    const totalImpact = directImpactCount + indirectImpactCount;
    if (totalImpact > 20 || affectedFiles.size > 10) {
      riskLevel = 'high';
    } else if (totalImpact > 8 || affectedFiles.size > 5) {
      riskLevel = 'medium';
    }

    return {
      affectedFiles: Array.from(affectedFiles),
      affectedSymbols,
      directImpactCount,
      indirectImpactCount,
      riskLevel,
    };
  }

  // ── 风险评估 ───────────────────────────────────────────────────────────
  private assessRisks(
    contextPackage: ContextPackage,
    impactSurface: ImpactSurface
  ): RiskAnalysis {
    const highRiskFiles: RiskItem[] = [];
    const breakingChanges: Array<{
      file: string;
      symbol: string;
      affectedDependents: string[];
    }> = [];
    const testCoverage: Array<{
      file: string;
      hasTests: boolean;
      testFiles: string[];
    }> = [];
    let complexityScore = 0;

    const allFiles = contextPackage.selectedFiles;

    // 优先从 Knowledge Base 获取关键文件和入口点
    const kbCritical = this.repoKnowledgeBase?.getCriticalFiles() || [];
    const kbEntryPoints = this.repoKnowledgeBase?.getEntryPoints() || [];
    const criticalSet = new Set(kbCritical.map((c) => c.path));
    const entryPointSet = new Set(kbEntryPoints.map((e) => e.path));

    for (const file of allFiles) {
      const node = this.dependencyGraph.getNode(file);
      if (!node) {
        continue;
      }

      if (entryPointSet.has(file)) {
        highRiskFiles.push({
          path: file,
          risk: 'entry_point',
          reason: '该文件是项目入口点，修改可能影响整个应用启动',
        });
      }

      if (criticalSet.has(file)) {
        const kbFile = kbCritical.find((c) => c.path === file);
        highRiskFiles.push({
          path: file,
          risk: 'high_dependents',
          reason: kbFile?.reason || `该文件被大量文件依赖，修改可能引发连锁反应`,
        });
      } else if (node.dependents.length > 5) {
        highRiskFiles.push({
          path: file,
          risk: 'high_dependents',
          reason: `该文件被 ${node.dependents.length} 个文件依赖，修改可能引发连锁反应`,
        });
      }

      const testFiles = this.findTestFiles(file);
      testCoverage.push({
        file,
        hasTests: testFiles.length > 0,
        testFiles,
      });

      if (
        node.dependents.length > 0 &&
        contextPackage.expandedNodes
      ) {
        const fileSymbols = contextPackage.expandedNodes.filter(
          (n) => n.filePath === file && n.depth === 0
        );
        for (const sym of fileSymbols) {
          breakingChanges.push({
            file,
            symbol: sym.symbolName,
            affectedDependents: node.dependents.slice(0, 5),
          });
        }
      }
    }

    const fileCount = allFiles.length;
    const symbolCount = contextPackage.expandedNodes?.length || 0;
    const impactCount =
      impactSurface.directImpactCount + impactSurface.indirectImpactCount;
    complexityScore = Math.min(
      100,
      fileCount * 5 + symbolCount * 2 + impactCount * 3
    );

    return {
      highRiskFiles,
      breakingChanges,
      testCoverage,
      complexityScore,
    };
  }

  // ── 范围估计 ───────────────────────────────────────────────────────────
  private async estimateScope(
    contextPackage: ContextPackage,
    impactSurface: ImpactSurface
  ): Promise<ScopeEstimate> {
    const fileCount = contextPackage.selectedFiles.length;
    const symbolCount = contextPackage.expandedNodes?.length || 0;
    const totalFiles = impactSurface.affectedFiles.length;

    let estimatedLines = 0;
    for (const file of contextPackage.selectedFiles) {
      try {
        const uri = vscode.Uri.file(file);
        const contentBytes = await vscode.workspace.fs.readFile(uri);
        const content = new TextDecoder().decode(contentBytes);
        estimatedLines += content.split('\n').length;
      } catch {
        estimatedLines += 50;
      }
    }

    let confidence: 'low' | 'medium' | 'high';
    let recommendation: string;

    if (totalFiles <= 5) {
      confidence = 'high';
      recommendation = '范围较小，可直接执行';
    } else if (totalFiles <= 10) {
      confidence = 'medium';
      recommendation = '范围中等，建议按模块分步执行';
    } else {
      confidence = 'low';
      recommendation =
        '范围较大，建议拆分为多个子任务或确认需求范围';
    }

    return {
      estimatedFiles: totalFiles,
      estimatedSymbols: symbolCount,
      estimatedLines,
      confidence,
      recommendation,
    };
  }

  // ── 工具方法 ───────────────────────────────────────────────────────────
  private extractRelatedSymbols(contextPackage: ContextPackage): RelatedSymbol[] {
    if (!contextPackage.expandedNodes) {
      return [];
    }
    return contextPackage.expandedNodes.map((node) => ({
      name: node.symbolName,
      kind: node.kind,
      filePath: node.filePath,
      line: node.line,
      relation: node.relation,
      depth: node.depth,
      score: node.score,
    }));
  }

  private buildInvolvedFiles(
    contextPackage: ContextPackage,
    impactSurface: ImpactSurface
  ): DiscoveredFile[] {
    const result: DiscoveredFile[] = [];
    const allFiles = new Set([
      ...contextPackage.primaryFiles,
      ...contextPackage.relatedFiles,
      ...impactSurface.affectedFiles,
    ]);

    for (const file of allFiles) {
      let role: DiscoveredFile['role'] = 'related';
      if (contextPackage.primaryFiles.includes(file)) {
        role = 'primary';
      } else if (contextPackage.relatedFiles.includes(file)) {
        role = 'related';
      } else {
        role = 'dependency';
      }

      const node = this.dependencyGraph.getNode(file);
      const symbolCount =
        contextPackage.expandedNodes?.filter((n) => n.filePath === file)
          .length || 0;

      result.push({
        path: file,
        role,
        relevanceScore: role === 'primary' ? 100 : role === 'related' ? 60 : 30,
        reason:
          role === 'primary'
            ? '主要修改目标'
            : role === 'related'
              ? '语义相关'
              : '依赖关系',
        symbolCount,
        dependencyCount: node
          ? node.dependencies.length + node.dependents.length
          : 0,
      });
    }

    return result.sort((a, b) => b.relevanceScore - a.relevanceScore);
  }

  private buildSummary(
    scope: ScopeEstimate,
    risk: RiskAnalysis,
    impact: ImpactSurface
  ): string {
    const parts: string[] = [];
    parts.push(
      `预计涉及 ${scope.estimatedFiles} 个文件，${scope.estimatedSymbols} 个符号`
    );
    parts.push(
      `影响面：直接依赖 ${impact.directImpactCount}，间接依赖 ${impact.indirectImpactCount}`
    );
    parts.push(`风险等级：${impact.riskLevel}`);
    if (risk.highRiskFiles.length > 0) {
      parts.push(
        `高风险文件：${risk.highRiskFiles
          .map((r) => r.path.split('/').pop())
          .join(', ')}`
      );
    }
    parts.push(`建议：${scope.recommendation}`);
    return parts.join('；');
  }

  private findTestFiles(sourceFile: string): string[] {
    const testPatterns = ['.test.', '.spec.'];
    const results: string[] = [];
    const allFiles = this.scanner.getSourceFiles();

    const baseName =
      sourceFile.replace(/\.[^.]+$/, '').split('/').pop() || '';

    for (const file of allFiles) {
      if (testPatterns.some((p) => file.path.includes(p))) {
        const testBase =
          file.path.replace(/\.[^.]+$/, '').split('/').pop() || '';
        if (
          testBase.includes(baseName) ||
          baseName.includes(testBase.replace(/\.(test|spec)$/, ''))
        ) {
          results.push(file.path);
        }
      }
    }

    return results;
  }
}
