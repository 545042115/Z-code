import * as vscode from 'vscode';
import { WorkspaceScanner, WorkspaceInfo } from './workspace-scanner';
import { SymbolIndex, SymbolEntry, IndexStats } from './symbol-index';
import { Retrieval, RelevantResult } from './retrieval';
import { DependencyGraph } from './dependency-graph';
import { RepoMap } from './repo-map';
import { RepoGraph } from './repo-graph';
import { ImpactAnalyzer, ImpactResult, BatchImpactResult } from './impact-analyzer';
import { ContextBuilder, ContextPackage } from './context-builder';
import { MemoryManager } from '../memory/memory-manager';
import { EmbeddingManager } from '../embedding/embedding-manager';
import { HybridRetrieval } from './hybrid-retrieval';
import { SymbolRetrieval } from './symbol-retrieval';
import { ContextExpansionEngine } from './context-expansion';
import { DiscoveryPhase } from '../discovery/discovery';
import { RepoKnowledgeBase } from '../memory/repo-knowledge-base';
import { ReflectionEngine } from '../reflection/reflection-engine';
import { Planner } from '../planner/planner';
import { GitAnalyzer } from '../git/git-analyzer';
import { RuntimeVerifier } from '../verifier/runtime-verifier';
import { AgentLoop } from '../agent/agent-loop';
import { TaskUnderstanding } from '../analysis/task-understanding/task-understanding';
import { ArchitectureReview } from '../analysis/architecture-review/architecture-review';
import { ReflectionAgent } from '../reflection/reflection-agent';
import { ChangeImpactAnalysis } from '../analysis/change-impact/change-impact-analysis';
import { ComplexityEstimator } from '../analysis/complexity/complexity-estimator';
import { SkillManager } from '../skills/skill-manager';

export interface AgentContext {
  currentFile?: string;
  selectedCode?: string;
  cursorPosition?: vscode.Position;
  openFiles: string[];
  diagnostics: vscode.Diagnostic[];
  workspaceInfo?: string;
  symbolStats?: IndexStats;
  repoMap?: string;
  dependencyGraph?: string;
  contextPackage?: ContextPackage;
}

export class ContextManager {
  readonly scanner: WorkspaceScanner;
  readonly symbolIndex: SymbolIndex;
  readonly retrieval: Retrieval;
  readonly dependencyGraph: DependencyGraph;
  readonly repoMap: RepoMap;
  readonly repoGraph: RepoGraph;
  readonly impactAnalyzer: ImpactAnalyzer;
  readonly contextBuilder: ContextBuilder;
  readonly memoryManager: MemoryManager;
  readonly embeddingManager: EmbeddingManager;
  readonly hybridRetrieval: HybridRetrieval;
  readonly planner: Planner;
  readonly gitAnalyzer: GitAnalyzer;
  readonly runtimeVerifier: RuntimeVerifier;
  readonly discoveryPhase: DiscoveryPhase;
  readonly repoKnowledgeBase: RepoKnowledgeBase;
  readonly reflectionEngine: ReflectionEngine;
  readonly reflectionAgent: ReflectionAgent;
  readonly taskUnderstanding: TaskUnderstanding;
  readonly architectureReview: ArchitectureReview;
  readonly changeImpactAnalysis: ChangeImpactAnalysis;
  readonly complexityEstimator: ComplexityEstimator;
  readonly skillManager: SkillManager;
  agentLoop?: AgentLoop;

  private initialized = false;
  private embeddingManagerDirty = false;

  constructor() {
    this.scanner = new WorkspaceScanner();
    this.symbolIndex = new SymbolIndex();
    this.retrieval = new Retrieval(this.scanner, this.symbolIndex);
    this.dependencyGraph = new DependencyGraph(this.scanner);
    this.repoMap = new RepoMap(this.scanner, this.symbolIndex, this.dependencyGraph);
    this.repoGraph = new RepoGraph(this.scanner, this.symbolIndex, this.dependencyGraph);
    this.impactAnalyzer = new ImpactAnalyzer(this.symbolIndex, this.dependencyGraph, this.repoMap);
    this.memoryManager = new MemoryManager();
    this.embeddingManager = new EmbeddingManager(this.scanner);
    this.hybridRetrieval = new HybridRetrieval(
      this.embeddingManager,
      this.repoGraph,
      this.dependencyGraph,
      this.symbolIndex
    );
    const symbolRetrieval = new SymbolRetrieval(this.symbolIndex);
    const contextExpansionEngine = new ContextExpansionEngine(
      this.symbolIndex,
      this.dependencyGraph,
      this.repoGraph
    );
    this.contextBuilder = new ContextBuilder(
      this.scanner,
      this.symbolIndex,
      this.dependencyGraph,
      this.repoMap,
      this.hybridRetrieval,
      symbolRetrieval,
      contextExpansionEngine
    );
    this.gitAnalyzer = new GitAnalyzer();
    this.runtimeVerifier = new RuntimeVerifier();
    this.planner = new Planner(this.memoryManager, this.hybridRetrieval, this.repoGraph, this.contextBuilder, this.symbolIndex, this.dependencyGraph, this.gitAnalyzer);
    this.repoKnowledgeBase = new RepoKnowledgeBase(
      this.scanner,
      this.repoGraph,
      this.repoMap,
      this.dependencyGraph,
      this.symbolIndex
    );
    this.reflectionEngine = new ReflectionEngine(this.runtimeVerifier, 3);
    this.reflectionAgent = new ReflectionAgent(this.reflectionEngine);
    this.taskUnderstanding = new TaskUnderstanding();
    this.architectureReview = new ArchitectureReview();
    this.complexityEstimator = new ComplexityEstimator();
    this.skillManager = new SkillManager();
    this.changeImpactAnalysis = new ChangeImpactAnalysis(
      this.symbolIndex,
      this.dependencyGraph,
      this.repoGraph
    );
    this.discoveryPhase = new DiscoveryPhase(
      this.repoGraph,
      this.dependencyGraph,
      this.scanner,
      this.repoKnowledgeBase
    );
  }

  async initialize(context: vscode.ExtensionContext): Promise<void> {
    if (this.initialized) return;

    vscode.window.showInformationMessage('Coding Agent: 正在扫描工作区文件...');

    await this.scanner.scan();

    const sourceFiles = this.scanner.getSourceFiles();
    const uris = sourceFiles.map(f => vscode.Uri.file(f.path));

    vscode.window.showInformationMessage(
      `Coding Agent: 正在索引 ${uris.length} 个源文件...`
    );

    await this.symbolIndex.buildForFiles(uris, (done, total) => {
      if (done % Math.max(1, Math.floor(total / 10)) === 0 || done === total) {
        const pct = Math.round((done / total) * 100);
        vscode.window.setStatusBarMessage(
          `$(sync) Coding Agent: 索引中 ${pct}% (${done}/${total})`,
          3000
        );
      }
    });

    const stats = this.symbolIndex.getStats();
    vscode.window.showInformationMessage(
      `Coding Agent: 索引完成 — ${stats.totalFiles} 个文件, ${stats.totalSymbols} 个符号`
    );

    vscode.window.setStatusBarMessage('$(graph) Coding Agent: 构建依赖关系图...', 3000);
    await this.dependencyGraph.build();
    await this.repoMap.build();
    this.repoGraph.build();

    vscode.window.showInformationMessage(
      `Coding Agent: 依赖图构建完成 — ${this.dependencyGraph.getAllNodes().length} 个节点`
    );

    vscode.window.setStatusBarMessage('$(book) Coding Agent: 构建仓库知识库...', 3000);
    await this.repoKnowledgeBase.init();
    if (this.repoKnowledgeBase.isReady) {
      const kb = this.repoKnowledgeBase.getKnowledge();
      vscode.window.showInformationMessage(
        `Coding Agent: 知识库已就绪 — ${kb?.architecture.layers.length || 0} 个模块层`
      );
    }

    vscode.window.setStatusBarMessage('$(repo) Coding Agent: 初始化 Git 分析器...', 3000);
    await this.gitAnalyzer.initialize();
    if (this.gitAnalyzer.isInitialized) {
      vscode.window.showInformationMessage('Coding Agent: Git 分析器已就绪');
    }

    vscode.window.setStatusBarMessage('$(check) Coding Agent: 初始化运行时验证器...', 3000);
    await this.runtimeVerifier.initialize();
    if (this.runtimeVerifier.isInitialized && this.runtimeVerifier.projectConfig?.type !== 'unknown') {
      vscode.window.showInformationMessage(`Coding Agent: 运行时验证器已就绪 (${this.runtimeVerifier.projectConfig?.type})`);
    }

    this.embeddingManager.build().catch(err => {
      console.error('EmbeddingManager build error (non-fatal):', err);
    });

    const watcher = this.scanner.watch();
    context.subscriptions.push(watcher);

    this.scanner.onFileChange(async (uri) => {
      const ext = uri.fsPath.substring(uri.fsPath.lastIndexOf('.'));
      if (this.scanner.SOURCE_EXTENSIONS.has(ext)) {
        this.symbolIndex.buildForFile(uri);
        // Incremental rebuild dependency graph and repo graph
        try {
          await this.dependencyGraph.build();
          this.repoGraph.build();
        } catch {
          // non-fatal: incremental rebuild failed
        }
        // Mark embedding as needing rebuild
        this.embeddingManagerDirty = true;
        this.hybridRetrieval.invalidate();
        // Incremental update repo knowledge base
        this.repoKnowledgeBase.scheduleIncrementalUpdate(uri.fsPath);
      }
    });

    this.scanner.onFileDelete((uri) => {
      const ext = uri.fsPath.substring(uri.fsPath.lastIndexOf('.'));
      if (this.scanner.SOURCE_EXTENSIONS.has(ext)) {
        // Remove from all indexes
        this.symbolIndex.removeFile(uri.fsPath);
        try {
          this.dependencyGraph.removeFile(uri.fsPath);
        } catch {
          // non-fatal
        }
        try {
          this.repoGraph.removeFile(uri.fsPath);
        } catch {
          // non-fatal
        }
        this.embeddingManagerDirty = true;
        this.hybridRetrieval.invalidate();
      }
    });

    this.initialized = true;
  }

  async gatherContext(): Promise<AgentContext> {
    if (this.embeddingManagerDirty && this.initialized) {
      this.embeddingManagerDirty = false;
      this.embeddingManager.build().catch(() => {});
      this.hybridRetrieval.invalidate();
    }

    const editor = vscode.window.activeTextEditor;
    const ctx: AgentContext = {
      currentFile: editor?.document.uri.fsPath,
      selectedCode: editor?.document.getText(editor.selection),
      cursorPosition: editor?.selection.active,
      openFiles: vscode.window.tabGroups.all
        .flatMap(g => g.tabs)
        .filter(t => t.input instanceof vscode.TabInputText)
        .map(t => (t.input as vscode.TabInputText).uri.fsPath),
      diagnostics: [],
      workspaceInfo: undefined,
    };

    if (editor) {
      ctx.diagnostics = vscode.languages.getDiagnostics(editor.document.uri)
        .filter(d => d.severity <= vscode.DiagnosticSeverity.Warning);
    }

    if (this.initialized) {
      ctx.workspaceInfo = await this.retrieval.summarizeWorkspace();
      ctx.symbolStats = this.symbolIndex.getStats();
      ctx.repoMap = this.repoMap.formatForPrompt(3);
      ctx.dependencyGraph = this.dependencyGraph.formatForPrompt();
    }

    return ctx;
  }

  async getDefinition(uri: vscode.Uri, position: vscode.Position): Promise<vscode.Location[]> {
    try {
      const locations = await vscode.commands.executeCommand<vscode.Location[]>(
        'vscode.executeDefinitionProvider',
        uri,
        position
      );
      return locations || [];
    } catch {
      return [];
    }
  }

  async getReferences(uri: vscode.Uri, position: vscode.Position): Promise<vscode.Location[]> {
    try {
      const locations = await vscode.commands.executeCommand<vscode.Location[]>(
        'vscode.executeReferenceProvider',
        uri,
        position
      );
      return locations || [];
    } catch {
      return [];
    }
  }

  async searchWorkspaceSymbols(query: string): Promise<vscode.SymbolInformation[]> {
    try {
      const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
        'vscode.executeWorkspaceSymbolProvider',
        query
      );
      return symbols || [];
    } catch {
      return [];
    }
  }

  async getHover(uri: vscode.Uri, position: vscode.Position): Promise<string> {
    try {
      const hover = await vscode.commands.executeCommand<vscode.Hover[]>(
        'vscode.executeHoverProvider',
        uri,
        position
      );
      if (hover && hover.length > 0) {
        return hover[0].contents
          .map(c => typeof c === 'string' ? c : c instanceof vscode.MarkdownString ? c.value : '')
          .join('\n');
      }
      return '';
    } catch {
      return '';
    }
  }

  async getCompletions(uri: vscode.Uri, position: vscode.Position): Promise<string[]> {
    try {
      const list = await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        uri,
        position
      );
      if (list) {
        return list.items.slice(0, 10).map(item => item.label.toString());
      }
      return [];
    } catch {
      return [];
    }
  }

  async findImplementations(uri: vscode.Uri, position: vscode.Position): Promise<vscode.Location[]> {
    try {
      const locations = await vscode.commands.executeCommand<vscode.Location[]>(
        'vscode.executeImplementationProvider',
        uri,
        position
      );
      return locations || [];
    } catch {
      return [];
    }
  }

  async getCodeActions(uri: vscode.Uri, range: vscode.Range): Promise<vscode.CodeAction[]> {
    try {
      const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
        'vscode.executeCodeActionProvider',
        uri,
        range
      );
      return actions || [];
    } catch {
      return [];
    }
  }

  isInitialized(): boolean {
    return this.initialized;
  }
}