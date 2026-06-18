import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ContextManager } from '../context/context-manager';

export interface ToolParameter {
  name: string;
  type: 'string' | 'number' | 'boolean';
  description: string;
  required: boolean;
  enum?: string[];
}

export interface Tool {
  name: string;
  description: string;
  parameters: ToolParameter[];
  execute: (params: Record<string, any>) => Promise<string>;
}

export class ToolRegistry {
  private tools: Map<string, Tool> = new Map();

  constructor(private readonly contextManager?: ContextManager) {
    this.registerDefaults();
  }

  private registerDefaults(): void {
    this.register(this.makeReadFileTool());
    this.register(this.makeWriteFileTool());
    this.register(this.makeReplaceTextTool());
    this.register(this.makeInsertBeforeTool());
    this.register(this.makeInsertAfterTool());
    this.register(this.makeAppendTextTool());
    this.register(this.makeSearchCodeTool());
    this.register(this.makeRunTerminalTool());
    this.register(this.makeListDirectoryTool());
    this.register(this.makeGetDiagnosticsTool());
    this.register(this.makeWebSearchTool());
    this.register(this.makeWebFetchTool());

    if (this.contextManager) {
      this.register(this.makeSearchSymbolsTool());
      this.register(this.makeGetWorkspaceContextTool());
      this.register(this.makeFindRelatedFilesTool());
      this.register(this.makeGetDefinitionTool());
      this.register(this.makeGetReferencesTool());
      this.register(this.makeGetRepoMapTool());
      this.register(this.makeGetDependencyGraphTool());
      this.register(this.makeAnalyzeImpactTool());
      this.register(this.makeBuildContextTool());
      this.register(this.makeProjectContextTool());
      this.register(this.makeMemorySearchTool());
      this.register(this.makeEmbeddingSearchTool());
      this.register(this.makeRepoGraphTool());
      this.register(this.makePlannerExecuteTool());
      this.register(this.makeGitRecentCommitsTool());
      this.register(this.makeGitFileHistoryTool());
      this.register(this.makeGitWorkingTreeDiffTool());
      this.register(this.makeGitDiffBetweenTool());
      this.register(this.makeGitBlameTool());
      this.register(this.makeGitChangedFilesTool());
      this.register(this.makeRuntimeVerifyBuildTool());
      this.register(this.makeRuntimeVerifyTestsTool());
      this.register(this.makeRuntimeVerifyLintTool());
      this.register(this.makeRuntimeVerifyPatchTool());
    }
  }

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /**
   * 将用户传入的路径解析为绝对路径。
   * 支持绝对路径和相对于工作区根目录的相对路径。
   */
  private resolveWorkspacePath(inputPath: string): string {
    if (!inputPath) {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!root) throw new Error('No workspace folder open');
      return root;
    }
    // 已经是绝对路径
    if (inputPath.match(/^[a-zA-Z]:[\\/]/) || inputPath.startsWith('/')) {
      return inputPath;
    }
    // 相对路径：解析为工作区根目录下的绝对路径
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) throw new Error('No workspace folder open. Please provide an absolute path.');
    const sep = root.includes('\\') ? '\\' : '/';
    return `${root}${sep}${inputPath.replace(/\//g, sep)}`;
  }

  private resolveWritableWorkspacePath(inputPath: string): string {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) {
      throw new Error('No workspace folder open. Please provide a path inside an open workspace.');
    }

    const normalizedRoot = path.resolve(root);
    const isWindowsWorkspace = /^[a-zA-Z]:[\\/]/.test(normalizedRoot);
    let normalizedInput = inputPath || '';

    // Windows 工作区下，将形如 "/foo/bar.py" 的伪绝对路径视为误用，改为相对路径处理。
    if (isWindowsWorkspace && /^\/[^/]/.test(normalizedInput)) {
      normalizedInput = normalizedInput.replace(/^\/+/, '');
    }

    const resolvedPath = path.isAbsolute(normalizedInput)
      ? path.resolve(normalizedInput)
      : path.resolve(normalizedRoot, normalizedInput);

    const relative = path.relative(normalizedRoot, resolvedPath);
    const isInsideWorkspace = relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
    if (!isInsideWorkspace) {
      throw new Error(`Path must be inside workspace root: ${normalizedRoot}. Use a relative path like "snake_game.py".`);
    }

    return resolvedPath;
  }

  getAll(): Tool[] {
    return Array.from(this.tools.values());
  }

  getToolListForPrompt(): string {
    return Array.from(this.tools.values()).map(t => {
      const params = t.parameters.map(p =>
        `  - ${p.name} (${p.type})${p.required ? ' [required]' : ' [optional]'}: ${p.description}${p.enum ? ` (${p.enum.join('|')})` : ''}`
      ).join('\n');
      return `${t.name}: ${t.description}\nParameters:\n${params}`;
    }).join('\n\n');
  }

  async execute(name: string, params: Record<string, any>): Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`Tool not found: ${name}`);
    }

    // 参数别名兼容：LLM 可能使用 training data 中的惯用参数名
    const aliasedParams = { ...params };
    const paramAliases: Record<string, Record<string, string>> = {
      read_file: { path: 'filePath' },
      write_file: { path: 'filePath' },
    };
    const aliases = paramAliases[name];
    if (aliases) {
      for (const [alias, canonical] of Object.entries(aliases)) {
        if (aliasedParams[canonical] === undefined && aliasedParams[alias] !== undefined) {
          aliasedParams[canonical] = aliasedParams[alias];
        }
      }
    }

    // 校验必填参数
    const missingParams = tool.parameters
      .filter(p => p.required && (aliasedParams[p.name] === undefined || aliasedParams[p.name] === null || aliasedParams[p.name] === ''))
      .map(p => p.name);
    if (missingParams.length > 0) {
      throw new Error(`Missing required parameter(s) for ${name}: ${missingParams.join(', ')}. Expected: ${tool.parameters.map(p => `${p.name}${p.required ? ' (required)' : ' (optional)'}`).join(', ')}`);
    }

    return await tool.execute(aliasedParams);
  }

  private makeReadFileTool(): Tool {
    return {
      name: 'read_file',
      description: 'Read the content of a file. Returns the full file content.',
      parameters: [
        { name: 'filePath', type: 'string', description: 'File path (absolute or relative to workspace root)', required: true },
        { name: 'startLine', type: 'number', description: 'Starting line number (1-based, optional)', required: false },
        { name: 'lineCount', type: 'number', description: 'Number of lines to read (optional)', required: false },
      ],
      execute: async (params) => {
        const resolvedPath = this.resolveWorkspacePath(params.filePath);
        if (!fs.existsSync(resolvedPath)) {
          // 防御性检查：阻止 Agent 读取不存在的文件，减少幻觉
          return `Error: File does not exist: ${resolvedPath}. Please use search_code or list_directory to locate the correct file path before reading.`;
        }
        const uri = vscode.Uri.file(resolvedPath);
        const doc = await vscode.workspace.openTextDocument(uri);
        const content = doc.getText();
        const lines = content.split('\n');

        if (params.startLine !== undefined) {
          const start = Math.max(0, (params.startLine || 1) - 1);
          const count = params.lineCount || lines.length;
          return lines.slice(start, start + count).join('\n');
        }

        return content;
      },
    };
  }

  private makeWriteFileTool(): Tool {
    return {
      name: 'write_file',
      description: 'Write content to a file. Creates the file if it does not exist. IMPORTANT: Only use this for creating new files or when you need to rewrite the entire file. For small changes to existing files, ALWAYS use replace_text, insert_before, insert_after, or append_text instead.',
      parameters: [
        { name: 'filePath', type: 'string', description: 'File path (absolute or relative to workspace root)', required: true },
        { name: 'content', type: 'string', description: 'Full file content to write', required: true },
      ],
      execute: async (params) => {
        const resolvedPath = this.resolveWritableWorkspacePath(params.filePath);

        // 防御性检查：阻止写入空内容
        if (!params.content || params.content.trim().length === 0) {
          return `Error: Cannot write empty content to ${resolvedPath}. Please provide valid file content.`;
        }

        const uri = vscode.Uri.file(resolvedPath);
        const encoder = new TextEncoder();
        const contentBytes = encoder.encode(params.content);

        try {
          await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(resolvedPath)));
        } catch (dirErr: any) {
          return `Error: Failed to create parent directory for ${resolvedPath}: ${dirErr.message}`;
        }

        try {
          await vscode.workspace.fs.writeFile(uri, contentBytes);
        } catch (writeErr: any) {
          return `Error: Failed to write file ${resolvedPath}: ${writeErr.message}`;
        }

        // 双重验证：确保文件确实被写入磁盘且内容一致
        try {
          const stat = await vscode.workspace.fs.stat(uri);
          if (stat.size === 0 && contentBytes.length > 0) {
            return `Warning: File ${resolvedPath} was written but size is 0 bytes. Content may have been lost.`;
          }
          return `File written successfully: ${resolvedPath} (${contentBytes.length} bytes, ${params.content.split('\n').length} lines)`;
        } catch (statErr: any) {
          return `Warning: File write appeared to succeed but could not verify ${resolvedPath}: ${statErr.message}`;
        }
      },
    };
  }

  /**
   * 局部编辑工具集：replace_text, insert_before, insert_after, append_text
   * 这些工具优先于 write_file 用于修改现有文件，避免传输完整文件内容。
   */

  private async applyLocalEdit(
    filePath: string,
    searchText: string,
    replaceText: string,
    operation: 'replace' | 'insert_before' | 'insert_after'
  ): Promise<string> {
    const resolvedPath = this.resolveWritableWorkspacePath(filePath);
    const uri = vscode.Uri.file(resolvedPath);

    // 检查文件是否存在
    let fileExists = false;
    try {
      await vscode.workspace.fs.stat(uri);
      fileExists = true;
    } catch {
      fileExists = false;
    }

    if (!fileExists) {
      // 文件不存在时，如果 searchText 为空则创建，否则报错
      if (!searchText) {
        const encoder = new TextEncoder();
        await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(resolvedPath)));
        await vscode.workspace.fs.writeFile(uri, encoder.encode(replaceText));
        return `File created successfully: ${resolvedPath}`;
      }
      throw new Error(`File not found: ${resolvedPath}. Use write_file or append_text to create new files.`);
    }

    const doc = await vscode.workspace.openTextDocument(uri);
    const fullText = doc.getText();

    // 精确匹配
    let matchIndex = fullText.indexOf(searchText);

    // 模糊匹配兜底（标准化空白字符）
    if (matchIndex === -1 && searchText) {
      matchIndex = this.fuzzySearchInText(fullText, searchText);
    }

    if (matchIndex === -1 && searchText) {
      throw new Error(`Search text not found in ${filePath}. The text may have been modified or does not match exactly.`);
    }

    let finalText: string;
    if (operation === 'replace') {
      finalText = fullText.substring(0, matchIndex) + replaceText + fullText.substring(matchIndex + searchText.length);
    } else if (operation === 'insert_before') {
      finalText = fullText.substring(0, matchIndex) + replaceText + searchText + fullText.substring(matchIndex + searchText.length);
    } else { // insert_after
      finalText = fullText.substring(0, matchIndex) + searchText + replaceText + fullText.substring(matchIndex + searchText.length);
    }

    const encoder = new TextEncoder();
    await vscode.workspace.fs.writeFile(uri, encoder.encode(finalText));

    const opLabel = operation === 'replace' ? 'replaced' : operation === 'insert_before' ? 'inserted before' : 'inserted after';
    const linesAffected = replaceText.split('\n').length;
    return `Text ${opLabel} successfully in ${resolvedPath} (${linesAffected} lines)`;
  }

  private fuzzySearchInText(text: string, pattern: string): number {
    const normalize = (s: string) => s.replace(/\s+/g, ' ').trim();
    const normalizedText = normalize(text);
    const normalizedPattern = normalize(pattern);
    const index = normalizedText.indexOf(normalizedPattern);
    if (index === -1) return -1;

    // 构建归一化位置映射
    const normToOriginal: number[] = [];
    let i = 0;
    while (i < text.length && /\s/.test(text[i])) i++;
    while (i < text.length) {
      if (/\s/.test(text[i])) {
        normToOriginal.push(i);
        while (i + 1 < text.length && /\s/.test(text[i + 1])) i++;
      } else {
        normToOriginal.push(i);
      }
      i++;
    }
    return index < normToOriginal.length ? normToOriginal[index] : -1;
  }

  private makeReplaceTextTool(): Tool {
    return {
      name: 'replace_text',
      description: 'Replace a specific text snippet in an existing file with new text. Use this for ALL modifications to existing files instead of write_file. The oldText must match exactly (or very closely) a portion of the file.',
      parameters: [
        { name: 'filePath', type: 'string', description: 'File path (absolute or relative to workspace root)', required: true },
        { name: 'oldText', type: 'string', description: 'The exact text to find and replace. Include enough surrounding context (2-3 lines) to ensure uniqueness.', required: true },
        { name: 'newText', type: 'string', description: 'The replacement text. Can be shorter or longer than oldText.', required: true },
      ],
      execute: async (params) => {
        return this.applyLocalEdit(params.filePath, params.oldText, params.newText, 'replace');
      },
    };
  }

  private makeInsertBeforeTool(): Tool {
    return {
      name: 'insert_before',
      description: 'Insert new text immediately before a specific anchor text in an existing file. The anchor text must exist in the file.',
      parameters: [
        { name: 'filePath', type: 'string', description: 'File path (absolute or relative to workspace root)', required: true },
        { name: 'anchorText', type: 'string', description: 'The anchor text to find. New text will be inserted BEFORE this text. Include enough context to ensure uniqueness.', required: true },
        { name: 'newText', type: 'string', description: 'The text to insert before the anchor.', required: true },
      ],
      execute: async (params) => {
        return this.applyLocalEdit(params.filePath, params.anchorText, params.newText, 'insert_before');
      },
    };
  }

  private makeInsertAfterTool(): Tool {
    return {
      name: 'insert_after',
      description: 'Insert new text immediately after a specific anchor text in an existing file. The anchor text must exist in the file.',
      parameters: [
        { name: 'filePath', type: 'string', description: 'File path (absolute or relative to workspace root)', required: true },
        { name: 'anchorText', type: 'string', description: 'The anchor text to find. New text will be inserted AFTER this text. Include enough context to ensure uniqueness.', required: true },
        { name: 'newText', type: 'string', description: 'The text to insert after the anchor.', required: true },
      ],
      execute: async (params) => {
        return this.applyLocalEdit(params.filePath, params.anchorText, params.newText, 'insert_after');
      },
    };
  }

  private makeAppendTextTool(): Tool {
    return {
      name: 'append_text',
      description: 'Append text to the end of a file. Creates the file if it does not exist. Use this for adding content to the end of a file without reading its entire content first.',
      parameters: [
        { name: 'filePath', type: 'string', description: 'File path (absolute or relative to workspace root)', required: true },
        { name: 'newText', type: 'string', description: 'Text to append at the end of the file. A newline will be added automatically if the file does not end with one.', required: true },
      ],
      execute: async (params) => {
        const resolvedPath = this.resolveWritableWorkspacePath(params.filePath);
        const uri = vscode.Uri.file(resolvedPath);
        let existing = '';
        try {
          const doc = await vscode.workspace.openTextDocument(uri);
          existing = doc.getText();
        } catch {
          // File does not exist, will create
        }
        const separator = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
        const finalText = existing + separator + params.newText;
        const encoder = new TextEncoder();
        await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(resolvedPath)));
        await vscode.workspace.fs.writeFile(uri, encoder.encode(finalText));
        return `Text appended successfully to ${resolvedPath}`;
      },
    };
  }

  private makeSearchCodeTool(): Tool {
    return {
      name: 'search_code',
      description: 'Search for text patterns across all workspace files.',
      parameters: [
        { name: 'pattern', type: 'string', description: 'Regex pattern to search for', required: true },
        { name: 'filePattern', type: 'string', description: 'Glob pattern to filter files (e.g. "*.ts")', required: false },
        { name: 'maxResults', type: 'number', description: 'Maximum results to return', required: false },
      ],
      execute: async (params) => {
        const maxResults = params.maxResults || 20;
        const includePattern = params.filePattern ? `**/${params.filePattern}` : '**/*';
        const excludePattern = '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/Pods/**,**/vendor/**,**/.cache/**}';

        const uris = await vscode.workspace.findFiles(
          includePattern,
          excludePattern,
          200
        );

        const results: { file: string; line: number; text: string }[] = [];
        // 不使用 g 标志，避免 lastIndex 递增导致交替漏匹配
        const regex = new RegExp(params.pattern, 'i');

        for (const uri of uris) {
          if (results.length >= maxResults) break;
          try {
            const doc = await vscode.workspace.openTextDocument(uri);
            for (let i = 0; i < doc.lineCount; i++) {
              const line = doc.lineAt(i);
              if (regex.test(line.text)) {
                results.push({
                  file: uri.fsPath,
                  line: i + 1,
                  text: line.text.trim().substring(0, 150),
                });
                if (results.length >= maxResults) break;
              }
            }
          } catch {
            continue;
          }
        }

        if (results.length === 0) {
          return `[搜索结果] 未找到匹配 "${params.pattern}" 的代码。请尝试：1) 简化搜索词 2) 使用 search_symbols 工具 3) 使用 list_directory 浏览项目结构`;
        }

        return results.map(r => `${r.file}:${r.line}: ${r.text}`).join('\n');
      },
    };
  }

  private static readonly DANGEROUS_COMMAND_PATTERNS = [
    /\brm\s+-rf\b/, /\brm\s+-r\b/, /\bdel\s+\/[sfq]/i,
    /\bformat\s+[a-z]:/i, /\bshutdown\b/i, /\breboot\b/i,
    /\bmkfs\b/i, /\bdd\s+if=/i, /\b:\(\)\{.*;\}\s*;/,
    /\bchmod\s+-R\s+777\b/, /\bchown\s+-R\b/,
    /\bgit\s+push\s+--force/i, /\bgit\s+reset\s+--hard/i,
    /\bgit\s+clean\s+-f/i, /\bgit\s+checkout\s+\.\s*$/i,
  ];

  private makeRunTerminalTool(): Tool {
    return {
      name: 'run_terminal',
      description: 'Execute a terminal command in the workspace root. Destructive commands require user confirmation.',
      parameters: [
        { name: 'command', type: 'string', description: 'Command to execute', required: true },
        { name: 'cwd', type: 'string', description: 'Working directory (default: workspace root)', required: false },
        { name: 'timeoutMs', type: 'number', description: 'Timeout in milliseconds', required: false },
      ],
      execute: async (params) => {
        const command: string = params.command || '';

        // 安全检查：检测危险命令
        for (const pattern of ToolRegistry.DANGEROUS_COMMAND_PATTERNS) {
          if (pattern.test(command)) {
            const confirm = await vscode.window.showWarningMessage(
              `⚠️ 该命令可能具有破坏性：\n\`${command}\`\n\n确认执行？`,
              { modal: true },
              '确认执行'
            );
            if (confirm !== '确认执行') {
              return 'Command cancelled by user (dangerous pattern detected).';
            }
            break;
          }
        }

        const cwd = params.cwd || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
        const timeout = params.timeoutMs || 30000;
        return new Promise<string>((resolve) => {
          const { exec } = require('child_process');
          exec(command, { cwd, timeout, maxBuffer: 1024 * 1024 }, (err: any, stdout: string, stderr: string) => {
            let result = '';
            if (stdout) result += `[stdout]\n${stdout.substring(0, 3000)}`;
            if (stderr) result += `\n[stderr]\n${stderr.substring(0, 1000)}`;
            if (err && !result) result = `Error: ${err.message}`;
            resolve(result || '(no output)');
          });
        });
      },
    };
  }

  private makeListDirectoryTool(): Tool {
    return {
      name: 'list_directory',
      description: 'List files and directories in a given path.',
      parameters: [
        { name: 'path', type: 'string', description: 'Directory path (absolute or relative to workspace root). Omit to list workspace root.', required: false },
        { name: 'depth', type: 'number', description: 'Maximum depth to traverse (default: 1)', required: false },
      ],
      execute: async (params) => {
        const depth = params.depth || 1;
        const resolvedPath = this.resolveWorkspacePath(params.path || '');
        const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(resolvedPath));
        const result: string[] = [];
        for (const [name, type] of entries) {
          const icon = type === vscode.FileType.Directory ? '[DIR]' : '[FILE]';
          result.push(`${icon} ${name}`);
        }
        return result.join('\n');
      },
    };
  }

  private makeGetDiagnosticsTool(): Tool {
    return {
      name: 'get_diagnostics',
      description: 'Get error/warning diagnostics for the current file or workspace.',
      parameters: [
        { name: 'filePath', type: 'string', description: 'Optional file path. If omitted, returns diagnostics for all files.', required: false },
      ],
      execute: async (params) => {
        const allDiagnostics = vscode.languages.getDiagnostics();
        const results: string[] = [];

        for (const [uri, diagnostics] of allDiagnostics) {
          if (params.filePath && uri.fsPath !== params.filePath) continue;
          const errors = diagnostics.filter(d => d.severity <= vscode.DiagnosticSeverity.Warning);
          if (errors.length === 0) continue;

          results.push(`\n${uri.fsPath}:`);
          for (const d of errors.slice(0, 10)) {
            const sev = d.severity === vscode.DiagnosticSeverity.Error ? 'ERROR' : 'WARN';
            results.push(`  [${sev}] ${d.message} (line ${d.range.start.line + 1})`);
          }
        }

        return results.join('\n') || 'No diagnostics found.';
      },
    };
  }

  private makeSearchSymbolsTool(): Tool {
    return {
      name: 'search_symbols',
      description: 'Search for code symbols (classes, functions, interfaces, etc.) across the workspace using the LSP-based index.',
      parameters: [
        { name: 'query', type: 'string', description: 'Symbol name or partial name to search for', required: true },
        { name: 'kind', type: 'string', description: 'Filter by symbol kind: class, function, interface, method, variable, enum', required: false, enum: ['class', 'function', 'interface', 'method', 'variable', 'enum'] },
        { name: 'maxResults', type: 'number', description: 'Maximum number of results', required: false },
      ],
      execute: async (params) => {
        if (!this.contextManager || !this.contextManager.isInitialized()) {
          return 'Code index not yet initialized. Please wait for indexing to complete.';
        }

        const maxResults = params.maxResults || 15;
        let results = this.contextManager.symbolIndex.search(params.query);

        if (params.kind) {
          results = results.filter(r => r.kind === params.kind);
        }

        results = results.slice(0, maxResults);

        if (results.length === 0) {
          return `No symbols found matching "${params.query}".`;
        }

        return results.map(r => {
          const path = r.filePath.split(/[/\\]/).slice(-3).join('/');
          return `${r.name} [${r.kind}] — ${path}:${r.line}${r.containerName ? ` (in ${r.containerName})` : ''}`;
        }).join('\n');
      },
    };
  }

  private makeGetWorkspaceContextTool(): Tool {
    return {
      name: 'get_workspace_context',
      description: 'Get an overview of the workspace structure: file counts, directories, language breakdown, and symbol statistics. Use this to understand the project layout before making changes.',
      parameters: [
        { name: 'detail', type: 'string', description: 'Level of detail: summary (default) or full', required: false, enum: ['summary', 'full'] },
      ],
      execute: async (params) => {
        if (!this.contextManager || !this.contextManager.isInitialized()) {
          return 'Code index not yet initialized. Please wait for indexing to complete.';
        }

        const overview = await this.contextManager.retrieval.summarizeWorkspace();

        if (params.detail === 'full') {
          const stats = this.contextManager.symbolIndex.getStats();
          const kindBreakdown = Object.entries(stats.byKind)
            .sort((a, b) => b[1] - a[1])
            .map(([kind, count]) => `  ${kind}: ${count}`)
            .join('\n');

          return `${overview}\n\nSymbol breakdown by kind:\n${kindBreakdown}`;
        }

        return overview;
      },
    };
  }

  private makeFindRelatedFilesTool(): Tool {
    return {
      name: 'find_related_files',
      description: 'Find files related to a given file. Uses the symbol index and directory structure to find files that are likely related.',
      parameters: [
        { name: 'filePath', type: 'string', description: 'Absolute path to the file', required: true },
        { name: 'maxResults', type: 'number', description: 'Maximum number of results', required: false },
      ],
      execute: async (params) => {
        if (!this.contextManager || !this.contextManager.isInitialized()) {
          return 'Code index not yet initialized. Please wait for indexing to complete.';
        }

        const maxResults = params.maxResults || 10;
        const related = await this.contextManager.retrieval.findRelatedFiles(params.filePath, maxResults);

        if (related.length === 0) {
          return 'No related files found.';
        }

        return related.map(f => {
          const path = f.path.split(/[/\\]/).slice(-3).join('/');
          const size = (f.size / 1024).toFixed(1);
          return `${path} (${size} KB)`;
        }).join('\n');
      },
    };
  }

  private makeGetDefinitionTool(): Tool {
    return {
      name: 'get_definition',
      description: 'Find the definition of a symbol at a given position in a file. Uses LSP go-to-definition.',
      parameters: [
        { name: 'filePath', type: 'string', description: 'Absolute path to the file', required: true },
        { name: 'line', type: 'number', description: 'Line number (1-based)', required: true },
        { name: 'column', type: 'number', description: 'Column number (1-based)', required: true },
      ],
      execute: async (params) => {
        if (!this.contextManager) {
          return 'ContextManager not available.';
        }

        const uri = vscode.Uri.file(params.filePath);
        const position = new vscode.Position((params.line || 1) - 1, (params.column || 1) - 1);
        const locations = await this.contextManager.getDefinition(uri, position);

        if (locations.length === 0) {
          return 'No definition found.';
        }

        return locations.map(l => `${l.uri.fsPath}:${l.range.start.line + 1}:${l.range.start.character + 1}`).join('\n');
      },
    };
  }

  private makeGetReferencesTool(): Tool {
    return {
      name: 'get_references',
      description: 'Find all references to a symbol at a given position in a file. Uses LSP find-references.',
      parameters: [
        { name: 'filePath', type: 'string', description: 'Absolute path to the file', required: true },
        { name: 'line', type: 'number', description: 'Line number (1-based)', required: true },
        { name: 'column', type: 'number', description: 'Column number (1-based)', required: true },
        { name: 'maxResults', type: 'number', description: 'Maximum number of results', required: false },
      ],
      execute: async (params) => {
        if (!this.contextManager) {
          return 'ContextManager not available.';
        }

        const uri = vscode.Uri.file(params.filePath);
        const position = new vscode.Position((params.line || 1) - 1, (params.column || 1) - 1);
        const locations = await this.contextManager.getReferences(uri, position);
        const maxResults = params.maxResults || 30;

        if (locations.length === 0) {
          return 'No references found.';
        }

        return locations.slice(0, maxResults).map(l =>
          `${l.uri.fsPath}:${l.range.start.line + 1}:${l.range.start.character + 1}`
        ).join('\n');
      },
    };
  }

  private makeGetRepoMapTool(): Tool {
    return {
      name: 'get_repo_map',
      description: 'Get a structured overview of the repository: directory tree, entry points, critical files, and module breakdown. Use this to understand the overall architecture before making changes.',
      parameters: [
        { name: 'depth', type: 'number', description: 'Directory tree depth (default: 3)', required: false },
        { name: 'detail', type: 'string', description: 'Level: overview (default) or full', required: false, enum: ['overview', 'full'] },
      ],
      execute: async (params) => {
        if (!this.contextManager || !this.contextManager.isInitialized()) {
          return 'Code index not yet initialized.';
        }
        const depth = params.depth || 3;
        if (params.detail === 'full') {
          const overview = this.contextManager.repoMap.formatForPrompt(depth);
          const risks = this.contextManager.impactAnalyzer.getArchitectureRisks();
          const riskLines = risks.map(r =>
            `  [${r.risk.toUpperCase()}] ${this.shortenPath(r.file)}: ${r.reason}`
          ).join('\n');
          return `${overview}\n\nArchitecture Risks:\n${riskLines}`;
        }
        return this.contextManager.repoMap.formatForPrompt(depth);
      },
    };
  }

  private makeGetDependencyGraphTool(): Tool {
    return {
      name: 'get_dependency_graph',
      description: 'Get dependency relationships for a file or view the overall dependency graph. Shows what a file imports and what imports it, including transitive dependents.',
      parameters: [
        { name: 'filePath', type: 'string', description: 'Absolute path to the file. If omitted, returns the overall graph summary.', required: false },
        { name: 'depth', type: 'number', description: 'Transitive depth for impact scope (default: 2)', required: false },
      ],
      execute: async (params) => {
        if (!this.contextManager || !this.contextManager.isInitialized()) {
          return 'Code index not yet initialized.';
        }
        const depth = params.depth || 2;
        if (params.filePath) {
          return this.contextManager.dependencyGraph.formatForPrompt(params.filePath, depth);
        }
        return this.contextManager.dependencyGraph.formatForPrompt();
      },
    };
  }

  private makeAnalyzeImpactTool(): Tool {
    return {
      name: 'analyze_impact',
      description: 'Analyze the potential impact of changing a file or symbol. Returns direct/transitive dependents, affected entry points, modules, and a critical score (low/medium/high/critical).',
      parameters: [
        { name: 'filePath', type: 'string', description: 'Absolute path to the file to analyze', required: false },
        { name: 'symbolName', type: 'string', description: 'Symbol name to analyze (alternative to filePath)', required: false },
        { name: 'depth', type: 'number', description: 'Transitive analysis depth (default: 3)', required: false },
      ],
      execute: async (params) => {
        if (!this.contextManager || !this.contextManager.isInitialized()) {
          return 'Code index not yet initialized.';
        }
        const depth = params.depth || 3;
        let result: import('../context/impact-analyzer').ImpactResult | null = null;

        if (params.filePath) {
          result = this.contextManager.impactAnalyzer.analyze(params.filePath, depth);
        } else if (params.symbolName) {
          result = this.contextManager.impactAnalyzer.analyzeSymbol(params.symbolName);
        } else {
          return 'Please provide either filePath or symbolName.';
        }

        if (!result) {
          return 'No analysis result: file or symbol not found.';
        }

        return result.summary;
      },
    };
  }

  private makeBuildContextTool(): Tool {
    return {
      name: 'build_context',
      description: 'Analyze a user request and automatically build a focused context package. Uses intent analysis, symbol search, and dependency graph to select the most relevant files. Use this as the FIRST tool when starting a new task.',
      parameters: [
        { name: 'request', type: 'string', description: 'The user request or task description', required: true },
        { name: 'currentFile', type: 'string', description: 'The currently open file path (optional)', required: false },
      ],
      execute: async (params) => {
        if (!this.contextManager || !this.contextManager.isInitialized()) {
          return 'Code index not yet initialized.';
        }
        const pkg = await this.contextManager.contextBuilder.build(params.request, params.currentFile);
        return this.contextManager.contextBuilder.formatForPrompt(pkg);
      },
    };
  }

  private makeProjectContextTool(): Tool {
    return {
      name: 'project_context',
      description: 'Build a comprehensive project understanding context. Collects architecture files, build configs, server modules, core modules, entry points, and generates a project summary. Use this when the user asks about what the project does, its architecture, structure, or wants an overview.',
      parameters: [
        { name: 'request', type: 'string', description: 'The user request about the project', required: true },
      ],
      execute: async (params) => {
        if (!this.contextManager || !this.contextManager.isInitialized()) {
          return 'Code index not yet initialized.';
        }
        const pkg = this.contextManager.contextBuilder.buildProjectContext(params.request);
        return this.contextManager.contextBuilder.formatProjectContextForPrompt(pkg);
      },
    };
  }

  private makeMemorySearchTool(): Tool {
    return {
      name: 'memory_search',
      description: 'Search conversation history from previous sessions. Retrieves relevant context by intent or content from multi-turn memory.',
      parameters: [
        { name: 'sessionId', type: 'string', description: 'Session ID to search in', required: false },
        { name: 'intent', type: 'string', description: 'Filter by intent: project_understanding, bug_fix, feature_add, refactor', required: false, enum: ['project_understanding', 'bug_fix', 'feature_add', 'refactor'] },
        { name: 'recentN', type: 'number', description: 'Number of recent entries to return (default: 5)', required: false },
      ],
      execute: async (params) => {
        if (!this.contextManager) {
          return 'ContextManager not available.';
        }
        const mm = this.contextManager.memoryManager;
        const sessionId = params.sessionId || `session-${vscode.workspace.workspaceFolders?.[0]?.uri.fsPath?.replace(/[^a-zA-Z0-9]/g, '-') || 'unknown'}`;

        if (params.intent) {
          const entries = mm.findByIntent(sessionId, params.intent);
          if (entries.length === 0) return `No memory entries found for intent "${params.intent}".`;
          return entries.slice(-10).map(e =>
            `[${e.role}] ${e.content.slice(0, 300)}`
          ).join('\n\n');
        }

        const recentN = params.recentN || 5;
        const context = mm.getContextForPrompt(sessionId, recentN);
        return context || 'No conversation history found.';
      },
    };
  }

  private makeEmbeddingSearchTool(): Tool {
    return {
      name: 'embedding_search',
      description: 'Search for semantically relevant files using hybrid retrieval (BM25 + embedding + graph relevance). Returns top-K files ranked by relevance to the query. Use this to find files related to a concept without knowing exact file names.',
      parameters: [
        { name: 'query', type: 'string', description: 'Natural language query describing what you are looking for', required: true },
        { name: 'topK', type: 'number', description: 'Number of results to return (default: 8)', required: false },
      ],
      execute: async (params) => {
        if (!this.contextManager || !this.contextManager.hybridRetrieval) {
          return 'Hybrid retrieval not available.';
        }
        const results = await this.contextManager.hybridRetrieval.search(params.query, { topK: params.topK || 8 });
        if (results.length === 0) {
          return `No semantically relevant files found for "${params.query}".`;
        }
        return results.map((r, i) =>
          `${i + 1}. ${r.filePath} (final: ${r.score}, bm25: ${r.bm25Score}, emb: ${r.embeddingScore}, graph: ${r.graphScore}, code: ${r.codeRelevanceScore}, type: ${r.fileTypeScore})\n   ${r.summary.slice(0, 100)}`
        ).join('\n');
      },
    };
  }

  private makeRepoGraphTool(): Tool {
    return {
      name: 'get_repo_graph',
      description: 'Get the RepoGraph: module dependency overview, data flow direction, cross-module dependencies, and module hierarchy tree. Shows server/core/UI/config/build layer relationships and data flow paths.',
      parameters: [
        { name: 'detail', type: 'string', description: 'Detail level: overview (default) or full', required: false, enum: ['overview', 'full'] },
      ],
      execute: async (params) => {
        if (!this.contextManager || !this.contextManager.repoGraph.isBuilt) {
          return 'RepoGraph not yet built. Please wait for initialization.';
        }
        if (params.detail === 'full') {
          return this.contextManager.repoGraph.formatForPrompt();
        }
        return this.contextManager.repoGraph.getDependencyOverview();
      },
    };
  }

  private makePlannerExecuteTool(): Tool {
    return {
      name: 'planner_execute',
      description: 'Execute the full pipeline planner for a user request: intent classification → memory retrieval → embedding search → repo graph query → context building → answer generation preparation. Returns the accumulated incremental context.',
      parameters: [
        { name: 'request', type: 'string', description: 'The user request to plan and execute', required: true },
        { name: 'sessionId', type: 'string', description: 'Session ID for memory retrieval', required: false },
      ],
      execute: async (params) => {
        if (!this.contextManager || !this.contextManager.isInitialized()) {
          return 'Code index not yet initialized.';
        }

        const planner = this.contextManager.planner;
        const sessionId = params.sessionId || `session-${vscode.workspace.workspaceFolders?.[0]?.uri.fsPath?.replace(/[^a-zA-Z0-9]/g, '-') || 'unknown'}`;

        const plan = planner.create(params.request, sessionId);
        const context = plan.context;

        for (const step of plan.steps) {
          await planner.executeStep(step, params.request, sessionId, context);
        }

        return planner.formatPlanForPrompt(plan);
      },
    };
  }

  // ── Git Tools ───────────────────────────────────────────────────────────

  private makeGitRecentCommitsTool(): Tool {
    return {
      name: 'git_recent_commits',
      description: 'Get recent git commit history. Use this to understand what changed recently in the repository, who made changes, and when.',
      parameters: [
        { name: 'limit', type: 'number', description: 'Number of commits to return (default: 10)', required: false },
      ],
      execute: async (params) => {
        if (!this.contextManager || !this.contextManager.gitAnalyzer.isInitialized) {
          return 'Git repository not available or not initialized.';
        }
        const commits = await this.contextManager.gitAnalyzer.getRecentCommits(params.limit || 10);
        return this.contextManager.gitAnalyzer.formatCommitsForPrompt(commits);
      },
    };
  }

  private makeGitFileHistoryTool(): Tool {
    return {
      name: 'git_file_history',
      description: 'Get the commit history for a specific file. Use this to understand when and why a file was modified, or who introduced specific changes.',
      parameters: [
        { name: 'filePath', type: 'string', description: 'Absolute or relative path to the file', required: true },
        { name: 'limit', type: 'number', description: 'Number of commits to return (default: 20)', required: false },
      ],
      execute: async (params) => {
        if (!this.contextManager || !this.contextManager.gitAnalyzer.isInitialized) {
          return 'Git repository not available or not initialized.';
        }
        const history = await this.contextManager.gitAnalyzer.getFileHistory(params.filePath, params.limit || 20);
        if (history.length === 0) return `No history found for ${params.filePath}.`;
        return history
          .map((h, i) => `${i + 1}. \`${h.hash.slice(0, 7)}\` ${h.message} — ${h.author} (${h.date})`)
          .join('\n');
      },
    };
  }

  private makeGitWorkingTreeDiffTool(): Tool {
    return {
      name: 'git_working_tree_diff',
      description: 'Get the diff of uncommitted changes in the working tree (staged + unstaged). Use this to see what the user has modified before making additional changes.',
      parameters: [],
      execute: async () => {
        if (!this.contextManager || !this.contextManager.gitAnalyzer.isInitialized) {
          return 'Git repository not available or not initialized.';
        }
        const diff = await this.contextManager.gitAnalyzer.getWorkingTreeDiff();
        return this.contextManager.gitAnalyzer.formatDiffForPrompt(diff, 150);
      },
    };
  }

  private makeGitDiffBetweenTool(): Tool {
    return {
      name: 'git_diff_between',
      description: 'Get the diff between two git refs (commits, branches, or tags). Use this to compare specific versions of the codebase.',
      parameters: [
        { name: 'fromRef', type: 'string', description: 'Starting ref (commit hash, branch, or tag)', required: true },
        { name: 'toRef', type: 'string', description: 'Ending ref (commit hash, branch, or tag)', required: true },
      ],
      execute: async (params) => {
        if (!this.contextManager || !this.contextManager.gitAnalyzer.isInitialized) {
          return 'Git repository not available or not initialized.';
        }
        const diff = await this.contextManager.gitAnalyzer.getDiffBetween(params.fromRef, params.toRef);
        return this.contextManager.gitAnalyzer.formatDiffForPrompt(diff, 150);
      },
    };
  }

  private makeGitBlameTool(): Tool {
    return {
      name: 'git_blame',
      description: 'Get git blame information for a file. Use this to find out who wrote specific lines and when. Optionally pass a line number to get blame for a single line.',
      parameters: [
        { name: 'filePath', type: 'string', description: 'Absolute or relative path to the file', required: true },
        { name: 'line', type: 'number', description: 'Specific line number (1-based). Omit to get all lines.', required: false },
      ],
      execute: async (params) => {
        if (!this.contextManager || !this.contextManager.gitAnalyzer.isInitialized) {
          return 'Git repository not available or not initialized.';
        }
        const lines = await this.contextManager.gitAnalyzer.getBlame(
          params.filePath,
          params.line !== undefined ? params.line : undefined
        );
        if (lines.length === 0) return `No blame information for ${params.filePath}.`;
        return lines
          .map(l => `L${l.line}: \`${l.commitHash.slice(0, 7)}\` ${l.author} (${l.date}) — ${l.summary}`)
          .join('\n');
      },
    };
  }

  private makeGitChangedFilesTool(): Tool {
    return {
      name: 'git_changed_files',
      description: 'Get the list of files changed in the working tree (staged, unstaged, and untracked). Use this to understand the current state of modifications before making additional changes.',
      parameters: [],
      execute: async () => {
        if (!this.contextManager || !this.contextManager.gitAnalyzer.isInitialized) {
          return 'Git repository not available or not initialized.';
        }
        const files = await this.contextManager.gitAnalyzer.getChangedFiles();
        if (files.length === 0) return 'No changes in working tree.';
        return files
          .map(f => `${f.status.toUpperCase().padEnd(10)} ${this.shortenPath(f.path)} (+${f.additions}/-${f.deletions})`)
          .join('\n');
      },
    };
  }

  // ── Runtime Verification Tools ─────────────────────────────────────────

  private makeRuntimeVerifyBuildTool(): Tool {
    return {
      name: 'runtime_verify_build',
      description: 'Run the project build command and report errors. Use this after making code changes to verify the code still compiles or builds correctly.',
      parameters: [],
      execute: async () => {
        if (!this.contextManager || !this.contextManager.runtimeVerifier.isInitialized) {
          return 'Runtime verifier not initialized.';
        }
        const result = await this.contextManager.runtimeVerifier.verifyBuild();
        return this.contextManager.runtimeVerifier.formatResultsForPrompt([result]);
      },
    };
  }

  private makeRuntimeVerifyTestsTool(): Tool {
    return {
      name: 'runtime_verify_tests',
      description: 'Run the project test suite and report failures. Use this after making changes to ensure existing tests still pass.',
      parameters: [],
      execute: async () => {
        if (!this.contextManager || !this.contextManager.runtimeVerifier.isInitialized) {
          return 'Runtime verifier not initialized.';
        }
        const result = await this.contextManager.runtimeVerifier.verifyTests();
        return this.contextManager.runtimeVerifier.formatResultsForPrompt([result]);
      },
    };
  }

  private makeRuntimeVerifyLintTool(): Tool {
    return {
      name: 'runtime_verify_lint',
      description: 'Run the project linter and report violations. Use this to catch style issues, unused variables, or potential bugs flagged by static analysis.',
      parameters: [],
      execute: async () => {
        if (!this.contextManager || !this.contextManager.runtimeVerifier.isInitialized) {
          return 'Runtime verifier not initialized.';
        }
        const result = await this.contextManager.runtimeVerifier.verifyLint();
        return this.contextManager.runtimeVerifier.formatResultsForPrompt([result]);
      },
    };
  }

  private makeRuntimeVerifyPatchTool(): Tool {
    return {
      name: 'runtime_verify_patch',
      description: 'Run build + tests for the current patch (changed files). Use this after a set of edits to verify nothing is broken. If build or tests fail, lint is also run for extra signal.',
      parameters: [
        { name: 'filesChanged', type: 'string', description: 'Comma-separated list of changed file paths', required: false },
      ],
      execute: async (params) => {
        if (!this.contextManager || !this.contextManager.runtimeVerifier.isInitialized) {
          return 'Runtime verifier not initialized.';
        }
        const files = params.filesChanged ? params.filesChanged.split(',').map((f: string) => f.trim()) : [];
        const results = await this.contextManager.runtimeVerifier.verifyPatch(files);
        return this.contextManager.runtimeVerifier.formatResultsForPrompt(results);
      },
    };
  }

  // ── Web Tools ────────────────────────────────────────────────────────────

  private makeWebSearchTool(): Tool {
    return {
      name: 'web_search',
      description: 'Search the web for information. Returns a list of search results with titles, URLs, and snippets. Use this to look up documentation, API references, error solutions, or any information not available in the local codebase.',
      parameters: [
        { name: 'query', type: 'string', description: 'Search query', required: true },
        { name: 'maxResults', type: 'number', description: 'Maximum number of results to return (default: 8)', required: false },
      ],
      execute: async (params) => {
        const maxResults = params.maxResults || 8;
        const query = encodeURIComponent(params.query);
        const url = `https://html.duckduckgo.com/html/?q=${query}`;

        try {
          const html = await this.fetchUrlContent(url);
          const results = this.parseDuckDuckGoResults(html, maxResults);

          if (results.length === 0) {
            return `[Web Search] No results found for "${params.query}".`;
          }

          return results.map((r, i) =>
            `${i + 1}. ${r.title}\n   URL: ${r.url}\n   ${r.snippet}`
          ).join('\n\n');
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return `[Web Search] Failed to search for "${params.query}": ${msg}`;
        }
      },
    };
  }

  private makeWebFetchTool(): Tool {
    return {
      name: 'web_fetch',
      description: 'Fetch the content of a web page and extract its text. Use this to read documentation pages, API references, or any web content. Returns the text content of the page with HTML tags stripped.',
      parameters: [
        { name: 'url', type: 'string', description: 'The URL to fetch', required: true },
        { name: 'maxLength', type: 'number', description: 'Maximum length of extracted text in characters (default: 5000)', required: false },
      ],
      execute: async (params) => {
        const maxLength = params.maxLength || 5000;

        try {
          const html = await this.fetchUrlContent(params.url);
          const text = this.stripHtmlTags(html);

          if (text.length > maxLength) {
            return text.substring(0, maxLength) + '\n\n[... content truncated]';
          }

          return text || '[Web Fetch] No text content could be extracted from the page.';
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return `[Web Fetch] Failed to fetch ${params.url}: ${msg}`;
        }
      },
    };
  }

  private fetchUrlContent(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const https = require('https');
      const http = require('http');
      const client = url.startsWith('https') ? https : http;

      const request = client.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
        },
        timeout: 15000,
      }, (response: any) => {
        // Handle redirects
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          const redirectUrl = new URL(response.headers.location, url).toString();
          this.fetchUrlContent(redirectUrl).then(resolve).catch(reject);
          return;
        }

        if (response.statusCode !== 200) {
          reject(new Error(`HTTP ${response.statusCode}`));
          return;
        }

        let data = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => { data += chunk; });
        response.on('end', () => { resolve(data); });
        response.on('error', reject);
      });

      request.on('error', reject);
      request.on('timeout', () => {
        request.destroy();
        reject(new Error('Request timed out'));
      });
    });
  }

  private stripHtmlTags(html: string): string {
    // Remove script and style blocks
    let text = html.replace(/<script[\s\S]*?<\/script>/gi, '');
    text = text.replace(/<style[\s\S]*?<\/style>/gi, '');
    text = text.replace(/<nav[\s\S]*?<\/nav>/gi, '');
    text = text.replace(/<footer[\s\S]*?<\/footer>/gi, '');

    // Convert common block elements to newlines
    text = text.replace(/<\/?(p|div|h[1-6]|li|br|tr|hr)[^>]*>/gi, '\n');
    text = text.replace(/<\/?(ul|ol|table|thead|tbody|blockquote|pre|article|section|header|main)[^>]*>/gi, '\n');

    // Remove all remaining HTML tags
    text = text.replace(/<[^>]+>/g, '');

    // Decode HTML entities
    text = text.replace(/&amp;/g, '&');
    text = text.replace(/&lt;/g, '<');
    text = text.replace(/&gt;/g, '>');
    text = text.replace(/&quot;/g, '"');
    text = text.replace(/&#39;/g, "'");
    text = text.replace(/&nbsp;/g, ' ');

    // Clean up whitespace
    text = text.replace(/[ \t]+/g, ' ');
    text = text.replace(/\n{3,}/g, '\n\n');
    return text.trim();
  }

  private parseDuckDuckGoResults(html: string, maxResults: number): { title: string; url: string; snippet: string }[] {
    const results: { title: string; url: string; snippet: string }[] = [];
    const resultRegex = /<a[^>]+class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
    let match;

    while ((match = resultRegex.exec(html)) !== null && results.length < maxResults) {
      const url = match[1];
      const title = this.stripHtmlTags(match[2]).trim();
      const snippet = this.stripHtmlTags(match[3]).trim();
      if (title && url) {
        results.push({ title, url, snippet: snippet || '(no snippet)' });
      }
    }

    // Fallback: try a simpler regex if the structured one didn't match
    if (results.length === 0) {
      const simpleRegex = /<a[^>]+class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
      while ((match = simpleRegex.exec(html)) !== null && results.length < maxResults) {
        const url = match[1];
        const title = this.stripHtmlTags(match[2]).trim();
        if (title && url) {
          results.push({ title, url, snippet: '(no snippet)' });
        }
      }
    }

    return results;
  }

  private shortenPath(filePath: string): string {
    const parts = filePath.replace(/\\/g, '/').split('/');
    const srcIndex = parts.lastIndexOf('src');
    if (srcIndex >= 0 && srcIndex < parts.length - 1) {
      return parts.slice(srcIndex + 1).join('/');
    }
    if (parts.length <= 3) return parts.join('/');
    return parts.slice(-3).join('/');
  }
}
