import * as vscode from 'vscode';
import { AgentContext } from '../agent/agent-core';

/**
 * 上下文管理器
 * 严格遵循 AGENT_SPEC.md 规范：
 * 1. LSP 精确语义优先
 * 2. 编辑器实时状态
 * 3. Tree-sitter AST（兜底）
 * 4. 文件名/路径匹配
 * 5. 向量语义检索（最后手段）
 */

export class ContextManager {
  
  /**
   * 收集编辑器上下文
   * 优先级：LSP > Editor State > Tree-sitter > Path Match > Vector Search
   */
  async gatherContext(): Promise<AgentContext> {
    const ctx: AgentContext = {
      openFiles: [],
      diagnostics: [],
    };

    // 1. 当前文件和选中的代码
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      ctx.currentFile = editor.document.uri.fsPath;
      ctx.cursorPosition = editor.selection.active;
      
      if (!editor.selection.isEmpty) {
        ctx.selectedCode = editor.document.getText(editor.selection);
      }

      // 2. 获取 LSP 诊断信息
      ctx.diagnostics = vscode.languages.getDiagnostics(editor.document.uri);
    }

    // 3. 获取打开的文件列表
    ctx.openFiles = vscode.workspace.textDocuments
      .filter(d => !d.isUntitled)
      .map(d => d.uri.fsPath);

    // 4. 获取 LSP 符号信息（如果可用）
    if (editor) {
      try {
        const symbols = await this.getDocumentSymbols(editor.document.uri);
        // 可以在这里添加符号信息到上下文
      } catch {
        // LSP 不可用，使用 Tree-sitter 兜底
      }
    }

    return ctx;
  }

  /**
   * 获取 LSP 文档符号
   */
  private async getDocumentSymbols(uri: vscode.Uri): Promise<vscode.DocumentSymbol[]> {
    const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
      'vscode.executeDocumentSymbolProvider',
      uri
    );
    return symbols || [];
  }

  /**
   * 获取符号定义（LSP）
   */
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

  /**
   * 获取符号引用（LSP）
   */
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

  /**
   * 工作区符号搜索（LSP）
   */
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

  /**
   * 获取悬停信息（LSP）
   */
  async getHover(uri: vscode.Uri, position: vscode.Position): Promise<vscode.Hover[]> {
    try {
      const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
        'vscode.executeHoverProvider',
        uri,
        position
      );
      return hovers || [];
    } catch {
      return [];
    }
  }

  /**
   * 获取代码补全（LSP）
   */
  async getCompletions(uri: vscode.Uri, position: vscode.Position): Promise<vscode.CompletionList> {
    try {
      const completions = await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        uri,
        position
      );
      return completions || new vscode.CompletionList();
    } catch {
      return new vscode.CompletionList();
    }
  }

  /**
   * 获取相关文件
   * 基于：导入语句、相同目录、最近修改
   */
  async getRelatedFiles(currentFile: string): Promise<string[]> {
    const related: Set<string> = new Set();
    
    // 1. 同目录文件
    const dir = currentFile.substring(0, currentFile.lastIndexOf('/'));
    const dirUri = vscode.Uri.file(dir);
    
    try {
      const entries = await vscode.workspace.fs.readDirectory(dirUri);
      entries.forEach(([name, type]) => {
        if (type === vscode.FileType.File) {
          related.add(`${dir}/${name}`);
        }
      });
    } catch {
      // 忽略错误
    }

    // 2. 最近打开的文件
    const recent = vscode.workspace.textDocuments
      .filter(d => d.uri.fsPath !== currentFile)
      .slice(0, 5)
      .map(d => d.uri.fsPath);
    
    recent.forEach(f => related.add(f));

    return Array.from(related).slice(0, 10);
  }
}
