import { WorkspaceScanner } from './workspaceScanner';
import { SymbolIndex, SymbolEntry } from './symbolIndex';
import { DependencyGraph } from './dependencyGraph';
import { RepoMap } from './repoMap';
import { HybridRetrieval } from './hybrid-retrieval';
import { SymbolRetrieval } from './symbolRetrieval';
import { ContextExpansionEngine, ContextNode, ExpansionResult } from './contextExpansion';

export interface ContextPackage {
  primaryFiles: string[];
  relatedFiles: string[];
  dependencyFiles: string[];
  selectedFiles: string[];
  expandedNodes?: ContextNode[];
  repoSummary: string;
  reason: string;
  gitContext?: string;
  verificationResults?: string;
}

export interface ProjectContextPackage {
  projectSummary: string;
  architectureFiles: string[];
  buildFiles: string[];
  serverModules: string[];
  coreModules: string[];
  entryPoints: string[];
  selectedFiles: string[];
  reason: string;
}

interface ScoredFile {
  filePath: string;
  score: number;
  role: 'primary' | 'related' | 'dependency';
}

export class ContextBuilder {
  private readonly MAX_PRIMARY = 5;
  private readonly MAX_RELATED = 8;
  private readonly MAX_DEPENDENCY = 5;
  private readonly MAX_TOTAL = 15;

  constructor(
    private readonly scanner: WorkspaceScanner,
    private readonly symbolIndex: SymbolIndex,
    private readonly dependencyGraph: DependencyGraph,
    private readonly repoMap: RepoMap,
    private readonly hybridRetrieval?: HybridRetrieval,
    private readonly symbolRetrieval?: SymbolRetrieval,
    private readonly contextExpansionEngine?: ContextExpansionEngine
  ) {}

  async build(userRequest: string, currentFile?: string, gitContext?: string, verificationResults?: string): Promise<ContextPackage> {
    const keywords = this.extractKeywords(userRequest);
    const intent = this.classifyIntent(userRequest);

    // 1. Hybrid Retrieval → TopK Files
    let topKFiles = await this.findPrimaryFiles(keywords, currentFile, intent);
    const topKFileResults = topKFiles.map((fp, idx) => ({
      filePath: fp,
      score: Math.max(1.0 - idx * 0.1, 0.1),
      summary: '',
      bm25Score: 0,
      embeddingScore: 0,
      graphScore: 0,
      codeRelevanceScore: 0,
      fileTypeScore: 0,
    }));

    // 2. Symbol Retrieval → Primary Symbols
    let primarySymbols: SymbolEntry[] = [];
    let expansionResult: ExpansionResult | undefined;

    if (this.symbolRetrieval && this.contextExpansionEngine) {
      const symbolResults = this.symbolRetrieval.search(userRequest, topKFileResults, {
        maxSymbols: 20,
        intent,
        currentFile,
      });
      primarySymbols = symbolResults.map(r => r.symbol);

      // 3. Context Expansion → Expanded Nodes
      if (primarySymbols.length > 0) {
        expansionResult = await this.contextExpansionEngine.expand(primarySymbols, {
          relations: ['import', 'export', 'call', 'reference', 'implement', 'inherit'],
          budget: { maxNodes: 30, maxFiles: 15, tokenBudget: 4000 },
          intent,
        });
      }
    }

    // 4. 组装文件列表
    let primaryFiles: string[];
    let relatedFiles: string[];
    let dependencyFiles: string[];
    let selectedFiles: string[];

    if (expansionResult) {
      // 新流程：基于扩展结果组装
      const allFiles = expansionResult.filesInvolved;
      primaryFiles = [...new Set(primarySymbols.map(s => s.filePath))];
      relatedFiles = allFiles.filter(f => !primaryFiles.includes(f));
      dependencyFiles = [];
      selectedFiles = allFiles.slice(0, this.MAX_TOTAL);
    } else {
      // 降级到旧流程
      primaryFiles = topKFiles.slice(0, this.MAX_PRIMARY);
      const relatedSet = new Set<string>();
      const dependencySet = new Set<string>();

      for (const pf of primaryFiles) {
        const node = this.dependencyGraph.getNode(pf);
        if (node) {
          for (const dep of node.dependents) {
            if (!primaryFiles.includes(dep)) relatedSet.add(dep);
          }
          for (const dep of node.dependencies) {
            if (!primaryFiles.includes(dep)) dependencySet.add(dep);
          }
        }
      }

      if (currentFile && !primaryFiles.includes(currentFile)) {
        const node = this.dependencyGraph.getNode(currentFile);
        if (node) {
          for (const dep of node.dependents) {
            if (!primaryFiles.includes(dep)) relatedSet.add(dep);
          }
          for (const dep of node.dependencies) {
            if (!primaryFiles.includes(dep)) dependencySet.add(dep);
          }
        }
      }

      relatedFiles = Array.from(relatedSet).slice(0, this.MAX_RELATED);
      dependencyFiles = Array.from(dependencySet).slice(0, this.MAX_DEPENDENCY);

      const allScored = this.scoreFiles(primaryFiles, relatedFiles, dependencyFiles, keywords);
      selectedFiles = allScored.slice(0, this.MAX_TOTAL).map(s => s.filePath);
    }

    const repoSummary = this.repoMap.formatAsciiTree(2);
    const reason = this.buildReason(userRequest, intent, primaryFiles, selectedFiles);

    return {
      primaryFiles,
      relatedFiles,
      dependencyFiles,
      selectedFiles,
      expandedNodes: expansionResult?.allNodes,
      repoSummary,
      reason,
      gitContext,
      verificationResults,
    };
  }

  formatForPrompt(pkg: ContextPackage): string {
    const parts: string[] = [];

    parts.push('## Repository Summary\n');
    parts.push(pkg.repoSummary);
    parts.push('');

    parts.push(`## Context: ${pkg.selectedFiles.length} files selected\n`);
    parts.push(`Reason: ${pkg.reason}\n`);

    if (pkg.primaryFiles.length > 0) {
      parts.push('### Primary Files\n');
      for (const f of pkg.primaryFiles) {
        parts.push(`  📄 ${this.shortenPath(f)}`);
      }
      parts.push('');
    }

    if (pkg.relatedFiles.length > 0) {
      parts.push('### Related Files (dependents)\n');
      for (const f of pkg.relatedFiles) {
        parts.push(`  📄 ${this.shortenPath(f)}`);
      }
      parts.push('');
    }

    if (pkg.dependencyFiles.length > 0) {
      parts.push('### Dependency Files\n');
      for (const f of pkg.dependencyFiles) {
        parts.push(`  📄 ${this.shortenPath(f)}`);
      }
      parts.push('');
    }

    parts.push('### Selected Files (full paths)\n');
    for (const f of pkg.selectedFiles) {
      parts.push(`  - \`${f}\``);
    }

    if (pkg.expandedNodes && pkg.expandedNodes.length > 0) {
      parts.push('');
      parts.push(`### Expanded Symbols (${pkg.expandedNodes.length} nodes)\n`);
      for (const node of pkg.expandedNodes.slice(0, 20)) {
        const depthLabel = node.depth === 0 ? 'P' : `${node.depth}H`;
        parts.push(`  [${depthLabel}|${node.relation}] ${node.kind} ${node.symbolName} (${this.shortenPath(node.filePath)}:${node.line})`);
      }
    }

    if (pkg.gitContext) {
      parts.push('');
      parts.push(pkg.gitContext);
    }

    if (pkg.verificationResults) {
      parts.push('');
      parts.push(pkg.verificationResults);
    }

    return parts.join('\n');
  }

  async buildIncremental(
    userRequest: string,
    embeddingFiles: string[],
    repoGraphFiles: string[],
    memoryFragments: string
  ): Promise<ContextPackage> {
    const keywords = this.extractKeywords(userRequest);
    const intent = this.classifyIntent(userRequest);

    const filePool = new Set<string>();
    for (const f of embeddingFiles) filePool.add(f);
    for (const f of repoGraphFiles) filePool.add(f);

    const primaryFiles = Array.from(filePool).slice(0, this.MAX_PRIMARY);
    const topKFileResults = primaryFiles.map((fp, idx) => ({
      filePath: fp,
      score: Math.max(1.0 - idx * 0.1, 0.1),
      summary: '',
      bm25Score: 0,
      embeddingScore: 0,
      graphScore: 0,
      codeRelevanceScore: 0,
      fileTypeScore: 0,
    }));

    // Symbol Retrieval + Context Expansion（增量构建同样支持）
    let expansionResult: ExpansionResult | undefined;
    let primarySymbols: SymbolEntry[] = [];

    if (this.symbolRetrieval && this.contextExpansionEngine) {
      const symbolResults = this.symbolRetrieval.search(userRequest, topKFileResults, {
        maxSymbols: 15,
        intent,
      });
      primarySymbols = symbolResults.map(r => r.symbol);

      if (primarySymbols.length > 0) {
        expansionResult = await this.contextExpansionEngine.expand(primarySymbols, {
          relations: ['import', 'export', 'call', 'reference', 'implement', 'inherit'],
          budget: { maxNodes: 20, maxFiles: 10, tokenBudget: 2500 },
          intent,
        });
      }
    }

    let relatedFiles: string[];
    let dependencyFiles: string[];
    let selectedFiles: string[];

    if (expansionResult) {
      const allFiles = expansionResult.filesInvolved;
      const primaryFileSet = new Set(primarySymbols.map(s => s.filePath));
      relatedFiles = allFiles.filter(f => !primaryFileSet.has(f));
      dependencyFiles = [];
      selectedFiles = allFiles.slice(0, this.MAX_TOTAL);
    } else {
      const relatedSet = new Set<string>();
      const dependencySet = new Set<string>();

      for (const pf of primaryFiles) {
        const node = this.dependencyGraph.getNode(pf);
        if (node) {
          for (const dep of node.dependents) {
            if (!primaryFiles.includes(dep)) relatedSet.add(dep);
          }
          for (const dep of node.dependencies) {
            if (!primaryFiles.includes(dep)) dependencySet.add(dep);
          }
        }
      }

      relatedFiles = Array.from(relatedSet).slice(0, this.MAX_RELATED);
      dependencyFiles = Array.from(dependencySet).slice(0, this.MAX_DEPENDENCY);

      const allScored = this.scoreFiles(primaryFiles, relatedFiles, dependencyFiles, keywords);
      selectedFiles = allScored.slice(0, this.MAX_TOTAL).map(s => s.filePath);
    }

    const repoSummary = this.repoMap.formatAsciiTree(2);
    const reason = `[Incremental] ${this.buildReason(userRequest, intent, primaryFiles, selectedFiles)}`;

    return {
      primaryFiles,
      relatedFiles,
      dependencyFiles,
      selectedFiles,
      expandedNodes: expansionResult?.allNodes,
      repoSummary,
      reason,
    };
  }

  private isExcludedPath(filePath: string): boolean {
    const lower = filePath.replace(/\\/g, '/').toLowerCase();
    const excludeDirs = ['/node_modules/', '/.git/', '/dist/', '/build/', '/out/',
      '/pods/', '/carthage/', '/vendor/bundle/', '/.cache/', '/.gradle/',
      '/target/', '/deriveddata/', '/.venv/', '/venv/', '/env/', '/.tox/'];
    return excludeDirs.some(d => lower.includes(d));
  }

  buildProjectContext(request: string): ProjectContextPackage {
    const intent = this.classifyProjectIntent(request);

    // 使用主工作区文件，避免多工作区场景下上下文污染
    const allFiles = this.scanner.getPrimaryWorkspaceFiles();
    const sourceFiles = this.scanner.getPrimaryWorkspaceSourceFiles().map(f => f.path);

    const readmeFiles = allFiles.filter(f =>
      /readme\.md$/i.test(f.path) && !this.isExcludedPath(f.path)
    ).map(f => f.path);

    const architectureFiles = allFiles.filter(f =>
      /architect|developing|design|overview|structure/i.test(f.path) && /\.(md|txt)$/i.test(f.path) && !this.isExcludedPath(f.path)
    ).map(f => f.path);

    const buildFiles = allFiles.filter(f =>
      /CMakeLists\.txt$|package\.json$|\.config\.(js|ts|json)$|tsconfig\..+\.json$|webpack\.config|Dockerfile|docker-compose|Makefile$/i.test(f.path) && !this.isExcludedPath(f.path)
    ).map(f => f.path);

    const serverModules = allFiles.filter(f =>
      /server|api|route|controller|handler|nav_server|render_server|map_server|map_editor/i.test(f.path) && !this.isExcludedPath(f.path)
    ).map(f => f.path);

    const nodeDegrees = sourceFiles.map(fp => ({
      path: fp,
      degree: (this.dependencyGraph.getNode(fp)?.dependencies.length || 0) +
              (this.dependencyGraph.getNode(fp)?.dependents.length || 0)
    }));
    nodeDegrees.sort((a, b) => b.degree - a.degree);
    const coreModules = nodeDegrees.slice(0, 10).map(n => n.path);

    const entryPoints = sourceFiles.filter(fp => {
      const node = this.dependencyGraph.getNode(fp);
      return node && node.isEntryPoint;
    }).slice(0, 3);

    const selectedSet = new Set<string>();

    // 项目介绍类问题优先放入源码证据，README 仅作为补充兜底。
    for (const f of [...entryPoints, ...coreModules, ...serverModules, ...buildFiles, ...architectureFiles]) {
      selectedSet.add(f);
    }

    if (selectedSet.size < 8) {
      for (const f of readmeFiles) {
        selectedSet.add(f);
        if (selectedSet.size >= 8) break;
      }
    }

    const selectedFiles = Array.from(selectedSet).slice(0, 15);

    const projectSummary = this.repoMap.formatAsciiTree(2);
    const reason = this.buildReason(request, intent, [], selectedFiles);

    return {
      projectSummary,
      architectureFiles: architectureFiles.slice(0, 5),
      buildFiles: buildFiles.slice(0, 5),
      serverModules: serverModules.slice(0, 5),
      coreModules: coreModules.slice(0, 5),
      entryPoints: entryPoints.slice(0, 3),
      selectedFiles,
      reason
    };
  }

  formatProjectContextForPrompt(pkg: ProjectContextPackage): string {
    const parts: string[] = [];

    parts.push('## Project Summary\n');
    parts.push(pkg.projectSummary);
    parts.push('');

    parts.push(`Reason: ${pkg.reason}\n`);

    if (pkg.architectureFiles.length > 0) {
      parts.push('### Architecture Files\n');
      for (const f of pkg.architectureFiles) {
        parts.push(`  🏗️ ${this.shortenPath(f)}`);
      }
      parts.push('');
    }

    if (pkg.buildFiles.length > 0) {
      parts.push('### Build Configuration Files\n');
      for (const f of pkg.buildFiles) {
        parts.push(`  ⚙️ ${this.shortenPath(f)}`);
      }
      parts.push('');
    }

    if (pkg.serverModules.length > 0) {
      parts.push('### Server Modules\n');
      for (const f of pkg.serverModules) {
        parts.push(`  🖥️ ${this.shortenPath(f)}`);
      }
      parts.push('');
    }

    if (pkg.coreModules.length > 0) {
      parts.push('### Core Modules\n');
      for (const f of pkg.coreModules) {
        parts.push(`  📦 ${this.shortenPath(f)}`);
      }
      parts.push('');
    }

    if (pkg.entryPoints.length > 0) {
      parts.push('### Entry Points\n');
      for (const f of pkg.entryPoints) {
        parts.push(`  🚪 ${this.shortenPath(f)}`);
      }
      parts.push('');
    }

    parts.push('### Selected Files\n');
    for (const f of pkg.selectedFiles) {
      parts.push(`  - \`${f}\``);
    }

    return parts.join('\n');
  }

  private classifyProjectIntent(request: string): string {
    const lower = request.toLowerCase();

    if (/微服务|microservice|service|deploy|cluster|container|docker|k8s|kubernetes/i.test(lower)) {
      return 'deployment';
    }
    if (/架构|architecture|design|overview|structure/i.test(lower)) {
      return 'architecture';
    }
    if (/配置|config|configuration|setup|install/i.test(lower)) {
      return 'configuration';
    }
    if (/测试|test|ci|cd|pipeline|integration/i.test(lower)) {
      return 'ci_cd';
    }

    return 'general';
  }

  private extractKeywords(request: string): string[] {
    const tokens = request
      .replace(/[^a-zA-Z0-9\u4e00-\u9fff_\-. ]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length > 1);

    const stopWords = new Set([
      'the', 'a', 'an', 'in', 'to', 'for', 'of', 'with', 'on', 'at', 'by',
      'from', 'as', 'is', 'it', 'this', 'that', 'and', 'or', 'but', 'not',
      'be', 'are', 'was', 'were', 'been', 'have', 'has', 'had', 'do', 'does',
      'did', 'will', 'would', 'can', 'could', 'should', 'may', 'might',
      'add', 'new', 'fix', 'change', 'remove', 'need', 'want', 'please',
      'help', 'make', 'implement', 'create', 'update', 'delete', 'modify',
      '我', '我们', '需要', '添加', '创建', '修改', '删除', '修复', '请',
    ]);

    return tokens.filter(t => !stopWords.has(t.toLowerCase()) && t.length > 1);
  }

  classifyIntent(request: string): string {
    const lower = request.toLowerCase();

    if (/这个项目是干什么|项目是干什么|项目是做什么|介绍项目|项目简介|项目介绍|解释项目|about this project/i.test(lower)) {
      return 'project_understanding';
    }
    if (/介绍.*项目|解释.*项目|这个项目.*作用|这个项目.*功能|这个项目.*用途/i.test(lower)) {
      return 'project_understanding';
    }
    if (/查看.*项目.*作用|查看.*项目.*功能|查看.*项目.*用途|当前项目.*作用|当前项目.*功能|当前项目.*用途|项目概述|项目概况/i.test(lower)) {
      return 'project_understanding';
    }
    if (/项目结构|目录结构|项目架构|分析项目|分析架构|项目组织/i.test(lower)) {
      return 'project_understanding';
    }
    if (/项目功能|项目模块|项目作用|项目说明|项目用途/i.test(lower)) {
      return 'project_understanding';
    }
    if (/修复|fix|bug|error|issue|crash|fail|not work|wrong|broken/i.test(lower)) {
      return 'bug_fix';
    }
    if (/添加|增加|新增|new|add|create|implement|feature/i.test(lower)) {
      return 'feature_add';
    }
    if (/重构|refactor|clean|improve|optimize|restruct/i.test(lower)) {
      return 'refactor';
    }
    if (/删除|remove|delete|drop/i.test(lower)) {
      return 'removal';
    }
    if (/测试|test|spec|unit|integration/i.test(lower)) {
      return 'testing';
    }
    if (/文档|doc|readme|comment|documentation|explain/i.test(lower)) {
      return 'documentation';
    }
    if (/搜索|search|查找资料|查一下|搜一下|网上|在线|web search|look up|google|bing|stackoverflow|github\.com|npmjs|pypi|docs\./i.test(lower)) {
      return 'other';
    }

    return 'other';
  }

  private async findPrimaryFiles(keywords: string[], currentFile?: string, intent?: string): Promise<string[]> {
    const fileScores = new Map<string, number>();

    for (const kw of keywords) {
      const symbolMatches = this.symbolIndex.search(kw, 10);
      for (const sym of symbolMatches) {
        const current = fileScores.get(sym.filePath) || 0;
        const bonus = sym.name.toLowerCase() === kw.toLowerCase() ? 10 : 5;
        fileScores.set(sym.filePath, current + bonus);
      }

      const pathMatches = this.matchFilesByPath(kw);
      for (const fp of pathMatches) {
        const current = fileScores.get(fp) || 0;
        fileScores.set(fp, current + 8);
      }
    }

    // Hybrid retrieval boost: semantic + lexical + graph relevance
    if (this.hybridRetrieval) {
      const query = keywords.join(' ');
      const hybridResults = await this.hybridRetrieval.search(query, { topK: this.MAX_PRIMARY * 2 });
      for (const r of hybridResults) {
        const current = fileScores.get(r.filePath) || 0;
        fileScores.set(r.filePath, current + r.score * 10);
      }
    }

    if (currentFile) {
      const current = fileScores.get(currentFile) || 0;
      fileScores.set(currentFile, current + 3);
    }

    const sorted = Array.from(fileScores.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, this.MAX_PRIMARY)
      .map(([fp]) => fp);

    const expanded = this.expandWithRelatedFiles(sorted, intent);

    return expanded.slice(0, this.MAX_PRIMARY);
  }

  private matchFilesByPath(keyword: string): string[] {
    const lowerKw = keyword.toLowerCase().replace(/[/\\]/g, '/');
    const results: string[] = [];
    const files = this.scanner.getSourceFiles();

    for (const f of files) {
      const lowerPath = f.path.toLowerCase().replace(/\\/g, '/');
      if (lowerPath.includes(lowerKw)) {
        results.push(f.path);
      }
    }

    return results;
  }

  private expandWithRelatedFiles(primaryFiles: string[], intent?: string): string[] {
    const result = new Set(primaryFiles);

    if (intent === 'bug_fix') {
      for (const pf of primaryFiles) {
        const node = this.dependencyGraph.getNode(pf);
        if (node) {
          for (const dep of node.dependencies) result.add(dep);
        }
      }
    }

    if (intent === 'refactor' || intent === 'feature_add') {
      for (const pf of primaryFiles) {
        const node = this.dependencyGraph.getNode(pf);
        if (node) {
          for (const dep of node.dependencies) result.add(dep);
          for (const dep of node.dependents.slice(0, 3)) result.add(dep);
        }
      }
    }

    return Array.from(result);
  }

  private scoreFiles(
    primary: string[],
    related: string[],
    dependency: string[],
    keywords: string[]
  ): ScoredFile[] {
    const scored: ScoredFile[] = [];

    for (const fp of primary) {
      scored.push({ filePath: fp, score: 100, role: 'primary' });
    }
    for (const fp of related) {
      scored.push({ filePath: fp, score: 60, role: 'related' });
    }
    for (const fp of dependency) {
      scored.push({ filePath: fp, score: 40, role: 'dependency' });
    }

    for (const s of scored) {
      const node = this.dependencyGraph.getNode(s.filePath);
      if (node) {
        s.score += Math.min(node.dependents.length * 3, 15);
        if (node.isEntryPoint) s.score += 10;
      }
    }

    const seen = new Set<string>();
    return scored.filter(s => {
      if (seen.has(s.filePath)) return false;
      seen.add(s.filePath);
      return true;
    }).sort((a, b) => b.score - a.score);
  }

  private buildReason(request: string, intent: string, primaryFiles: string[], selectedFiles: string[]): string {
    const intentLabels: Record<string, string> = {
      bug_fix: 'Bug fix',
      feature_add: 'Feature addition',
      refactor: 'Refactoring',
      removal: 'Code removal',
      testing: 'Testing',
      documentation: 'Documentation',
      other: 'General task',
    };

    const label = intentLabels[intent] || 'General task';
    const primaryNames = primaryFiles.map(f => this.shortenPath(f)).join(', ');
    const relatedCount = selectedFiles.length - primaryFiles.length;

    return `${label}: identified ${primaryFiles.length} primary file(s) (${primaryNames}) and ${relatedCount} additional related/dependency files based on request: "${request.slice(0, 60)}"`;
  }

  private shortenPath(filePath: string): string {
    const parts = filePath.replace(/\\/g, '/').split('/');
    const srcIndex = parts.lastIndexOf('src');
    if (srcIndex >= 0) {
      const sliced = parts.slice(srcIndex + 1);
      if (sliced.length > 0) return sliced.join('/');
      return parts[srcIndex];
    }
    if (parts.length <= 3) return parts.join('/');
    return parts.slice(-3).join('/');
  }
}
