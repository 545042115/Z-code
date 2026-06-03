import * as vscode from 'vscode';
import { WorkspaceScanner, WorkspaceInfo } from './workspaceScanner';
import { SymbolIndex, SymbolEntry, IndexStats } from './symbolIndex';
import { Retrieval, RelevantResult } from './retrieval';
import { DependencyGraph } from './dependencyGraph';
import { RepoMap } from './repoMap';
import { RepoGraph } from './repoGraph';
import { ImpactAnalyzer, ImpactResult, BatchImpactResult } from './impactAnalyzer';
import { ContextBuilder, ContextPackage } from './contextBuilder';
import { MemoryManager } from '../memory/memoryManager';
import { EmbeddingManager } from '../embedding/embeddingManager';
import { Planner } from '../planner/planner';

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
  readonly planner: Planner;

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
    this.contextBuilder = new ContextBuilder(this.scanner, this.symbolIndex, this.dependencyGraph, this.repoMap);
    this.memoryManager = new MemoryManager();
    this.embeddingManager = new EmbeddingManager(this.scanner);
    this.planner = new Planner(this.memoryManager, this.embeddingManager, this.repoGraph, this.contextBuilder);
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
      }
    });

    this.initialized = true;
  }

  async gatherContext(): Promise<AgentContext> {
    if (this.embeddingManagerDirty && this.initialized) {
      this.embeddingManagerDirty = false;
      this.embeddingManager.build().catch(() => {});
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