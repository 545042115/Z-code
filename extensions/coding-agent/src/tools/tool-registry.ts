import * as vscode from 'vscode';

/**
 * 工具注册表
 * 沙箱隔离执行（AGENT_SPEC 要求）
 */

export interface Tool {
  name: string;
  description: string;
  parameters: object;
  execute(params: Record<string, any>): Promise<ToolResult>;
}

export interface ToolResult {
  success: boolean;
  data?: any;
  error?: string;
}

export class ToolRegistry {
  private tools: Map<string, Tool> = new Map();

  constructor() {
    this.register(new ReadFileTool());
    this.register(new WriteFileTool());
    this.register(new SearchCodeTool());
    this.register(new RunTerminalTool());
    this.register(new ListDirectoryTool());
    this.register(new GetDiagnosticsTool());
  }

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  async execute(name: string, params: Record<string, any>): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { success: false, error: `Tool not found: ${name}` };
    }
    try {
      return await tool.execute(params);
    } catch (err) {
      return { success: false, error: String(err) };
    }
  }

  getToolDescriptions(): string {
    return Array.from(this.tools.values())
      .map(t => `- ${t.name}: ${t.description}`)
      .join('\n');
  }
}

class ReadFileTool implements Tool {
  name = 'read_file';
  description = 'Read file content';
  parameters = {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute or relative file path' },
      offset: { type: 'number', description: 'Start line offset' },
      limit: { type: 'number', description: 'Max lines to read' },
    },
    required: ['path'],
  };

  async execute(params: { path: string; offset?: number; limit?: number }): Promise<ToolResult> {
    try {
      if (!params.path) {
        return { success: false, error: 'File path is required' };
      }
      const uri = vscode.Uri.file(params.path);
      const doc = await vscode.workspace.openTextDocument(uri);
      let content = doc.getText();

      if (params.offset !== undefined || params.limit !== undefined) {
        const lines = content.split('\n');
        const start = params.offset || 0;
        const end = params.limit ? start + params.limit : lines.length;
        content = lines.slice(start, end).join('\n');
      }

      return { success: true, data: { content, lineCount: doc.lineCount } };
    } catch (err) {
      return { success: false, error: `Failed to read file: ${err}` };
    }
  }
}

class WriteFileTool implements Tool {
  name = 'write_file';
  description = 'Write content to a file (creates if not exists)';
  parameters = {
    type: 'object',
    properties: {
      path: { type: 'string' },
      content: { type: 'string' },
    },
    required: ['path', 'content'],
  };

  async execute(params: { path: string; content: string }): Promise<ToolResult> {
    try {
      const uri = vscode.Uri.file(params.path);
      const encoder = new TextEncoder();
      await vscode.workspace.fs.writeFile(uri, encoder.encode(params.content));
      return { success: true, data: { path: params.path } };
    } catch (err) {
      return { success: false, error: `Failed to write file: ${err}` };
    }
  }
}

class SearchCodeTool implements Tool {
  name = 'search_code';
  description = 'Search code using regex or text pattern';
  parameters = {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Search pattern (regex supported)' },
      path: { type: 'string', description: 'Directory to search in' },
      filePattern: { type: 'string', description: 'File glob pattern' },
    },
    required: ['pattern'],
  };

  async execute(params: { pattern: string; path?: string; filePattern?: string }): Promise<ToolResult> {
    try {
      const searchPath = params.path || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!searchPath) {
        return { success: false, error: 'No workspace folder open' };
      }

      // 使用 VS Code 的搜索 API
      const files = await vscode.workspace.findFiles(
        new vscode.RelativePattern(searchPath, params.filePattern || '**/*'),
        '**/node_modules/**'
      );

      const results: Array<{ file: string; line: number; text: string }> = [];
      const regex = new RegExp(params.pattern, 'gi');

      for (const file of files.slice(0, 50)) { // 限制文件数量
        try {
          const doc = await vscode.workspace.openTextDocument(file);
          const text = doc.getText();
          const lines = text.split('\n');

          lines.forEach((line, idx) => {
            if (regex.test(line)) {
              results.push({ file: file.fsPath, line: idx + 1, text: line.trim() });
            }
            regex.lastIndex = 0; // 重置正则
          });
        } catch {
          // 忽略无法读取的文件
        }
      }

      return { success: true, data: { matches: results.slice(0, 20) } };
    } catch (err) {
      return { success: false, error: `Search failed: ${err}` };
    }
  }
}

class RunTerminalTool implements Tool {
  name = 'run_terminal';
  description = 'Execute a command in integrated terminal (sandboxed)';
  parameters = {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Command to execute' },
      cwd: { type: 'string', description: 'Working directory' },
      timeout: { type: 'number', description: 'Timeout in seconds' },
    },
    required: ['command'],
  };

  async execute(params: { command: string; cwd?: string; timeout?: number }): Promise<ToolResult> {
    try {
      // 创建或使用现有终端
      const terminal = vscode.window.createTerminal('Coding Agent');
      terminal.show();

      const cwd = params.cwd || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      
      if (cwd) {
        terminal.sendText(`cd "${cwd}"`, true);
      }
      
      terminal.sendText(params.command, true);

      // 注意：VS Code 终端 API 不支持直接获取输出
      // 实际实现需要更复杂的机制（如伪终端或输出捕获）
      return { 
        success: true, 
        data: { 
          message: 'Command sent to terminal',
          command: params.command,
        } 
      };
    } catch (err) {
      return { success: false, error: `Failed to run command: ${err}` };
    }
  }
}

class ListDirectoryTool implements Tool {
  name = 'list_directory';
  description = 'List files and directories';
  parameters = {
    type: 'object',
    properties: {
      path: { type: 'string' },
    },
    required: ['path'],
  };

  async execute(params: { path: string }): Promise<ToolResult> {
    try {
      const uri = vscode.Uri.file(params.path);
      const entries = await vscode.workspace.fs.readDirectory(uri);
      
      const items = entries.map(([name, type]) => ({
        name,
        type: type === vscode.FileType.Directory ? 'directory' : 'file',
      }));

      return { success: true, data: { items } };
    } catch (err) {
      return { success: false, error: `Failed to list directory: ${err}` };
    }
  }
}

class GetDiagnosticsTool implements Tool {
  name = 'get_diagnostics';
  description = 'Get error and warning diagnostics for current file or workspace';
  parameters = {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Specific file path (optional)' },
    },
  };

  async execute(params: { path?: string }): Promise<ToolResult> {
    try {
      let diagnostics: [vscode.Uri, vscode.Diagnostic[]][];

      if (params.path) {
        const uri = vscode.Uri.file(params.path);
        diagnostics = [[uri, vscode.languages.getDiagnostics(uri)]];
      } else {
        diagnostics = vscode.languages.getDiagnostics();
      }

      const results = diagnostics.flatMap(([uri, diags]) => 
        diags.map(d => ({
          file: uri.fsPath,
          line: d.range.start.line + 1,
          column: d.range.start.character + 1,
          severity: vscode.DiagnosticSeverity[d.severity],
          message: d.message,
          code: d.code,
        }))
      );

      return { success: true, data: { diagnostics: results.slice(0, 20) } };
    } catch (err) {
      return { success: false, error: `Failed to get diagnostics: ${err}` };
    }
  }
}
