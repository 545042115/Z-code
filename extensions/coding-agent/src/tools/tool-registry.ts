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
    this.register(this.makeSearchCodeTool());
    this.register(this.makeRunTerminalTool());
    this.register(this.makeListDirectoryTool());
    this.register(this.makeGetDiagnosticsTool());

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
    }
  }

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
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
    return await tool.execute(params);
  }

  private makeReadFileTool(): Tool {
    return {
      name: 'read_file',
      description: 'Read the content of a file. Returns the full file content.',
      parameters: [
        { name: 'path', type: 'string', description: 'Absolute path to the file', required: true },
        { name: 'startLine', type: 'number', description: 'Starting line number (1-based, optional)', required: false },
        { name: 'lineCount', type: 'number', description: 'Number of lines to read (optional)', required: false },
      ],
      execute: async (params) => {
        const uri = vscode.Uri.file(params.path);
        try {
          const doc = await vscode.workspace.openTextDocument(uri);
          const content = doc.getText();
          const lines = content.split('\n');

          if (params.startLine !== undefined) {
            const start = Math.max(0, (params.startLine || 1) - 1);
            const count = params.lineCount || lines.length;
            return lines.slice(start, start + count).join('\n');
          }

          return content;
        } catch (err) {
          return `Error reading file: ${err}`;
        }
      },
    };
  }

  private makeWriteFileTool(): Tool {
    return {
      name: 'write_file',
      description: 'Write content to a file. Creates the file if it does not exist.',
      parameters: [
        { name: 'path', type: 'string', description: 'Absolute path to the file', required: true },
        { name: 'content', type: 'string', description: 'Full file content to write', required: true },
      ],
      execute: async (params) => {
        const uri = vscode.Uri.file(params.path);
        try {
          const encoder = new TextEncoder();
          await vscode.workspace.fs.writeFile(uri, encoder.encode(params.content));
          return `File written: ${params.path}`;
        } catch (err) {
          return `Error writing file: ${err}`;
        }
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
        const excludePattern = '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**}';

        try {
          const uris = await vscode.workspace.findFiles(
            includePattern,
            excludePattern,
            200
          );

          const results: { file: string; line: number; text: string }[] = [];
          const regex = new RegExp(params.pattern, 'gi');

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
            return 'No results found.';
          }

          return results.map(r => `${r.file}:${r.line}: ${r.text}`).join('\n');
        } catch (err) {
          return `Error searching code: ${err}`;
        }
      },
    };
  }

  private makeRunTerminalTool(): Tool {
    return {
      name: 'run_terminal',
      description: 'Execute a terminal command in the workspace root.',
      parameters: [
        { name: 'command', type: 'string', description: 'Command to execute', required: true },
        { name: 'cwd', type: 'string', description: 'Working directory (default: workspace root)', required: false },
        { name: 'timeoutMs', type: 'number', description: 'Timeout in milliseconds', required: false },
      ],
      execute: async (params) => {
        const cwd = params.cwd || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
        const timeout = params.timeoutMs || 30000;
        return new Promise<string>((resolve) => {
          const { exec } = require('child_process');
          exec(params.command, { cwd, timeout, maxBuffer: 1024 * 1024 }, (err: any, stdout: string, stderr: string) => {
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
        { name: 'path', type: 'string', description: 'Absolute path to the directory', required: true },
        { name: 'depth', type: 'number', description: 'Maximum depth to traverse (default: 1)', required: false },
      ],
      execute: async (params) => {
        const depth = params.depth || 1;
        try {
          const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(params.path));
          const result: string[] = [];
          for (const [name, type] of entries) {
            const icon = type === vscode.FileType.Directory ? '[DIR]' : '[FILE]';
            result.push(`${icon} ${name}`);
          }
          return result.join('\n');
        } catch (err) {
          return `Error listing directory: ${err}`;
        }
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
        let result: import('../context/impactAnalyzer').ImpactResult | null = null;

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
      description: 'Search for semantically relevant files using TF-IDF style embedding. Returns top-K files ranked by relevance to the query. Use this to find files related to a concept without knowing exact file names.',
      parameters: [
        { name: 'query', type: 'string', description: 'Natural language query describing what you are looking for', required: true },
        { name: 'topK', type: 'number', description: 'Number of results to return (default: 8)', required: false },
      ],
      execute: async (params) => {
        if (!this.contextManager || !this.contextManager.embeddingManager.isBuilt) {
          return 'Embedding index not yet built. Please wait for initialization to complete.';
        }
        const results = this.contextManager.embeddingManager.search(params.query, params.topK || 8);
        if (results.length === 0) {
          return `No semantically relevant files found for "${params.query}".`;
        }
        return results.map((r, i) =>
          `${i + 1}. ${r.filePath} (score: ${r.score})\n   ${r.summary.slice(0, 100)}`
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