import * as vscode from 'vscode';
import { WorkspaceScanner, WorkspaceInfo } from './workspaceScanner';
import { SymbolIndex, SymbolEntry, IndexStats } from './symbolIndex';
import { Retrieval, RelevantResult } from './retrieval';

export interface AgentContext {
  currentFile?: string;
  selectedCode?: string;
  cursorPosition?: vscode.Position;
  openFiles: string[];
  diagnostics: vscode.Diagnostic[];
  workspaceInfo?: string;
  symbolStats?: IndexStats;
}

export class ContextManager {
  readonly scanner: WorkspaceScanner;
  readonly symbolIndex: SymbolIndex;
  readonly retrieval: Retrieval;

  private initialized = false;

  constructor() {
    this.scanner = new WorkspaceScanner();
    this.symbolIndex = new SymbolIndex();
    this.retrieval = new Retrieval(this.scanner, this.symbolIndex);
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

    const watcher = this.scanner.watch();
    context.subscriptions.push(watcher);

    this.scanner.onFileChange((uri) => {
      const ext = uri.fsPath.substring(uri.fsPath.lastIndexOf('.'));
      if (this.scanner.SOURCE_EXTENSIONS.has(ext)) {
        this.symbolIndex.buildForFile(uri);
      }
    });

    this.initialized = true;
  }

  async gatherContext(): Promise<AgentContext> {
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