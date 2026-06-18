import * as vscode from 'vscode';
import { SymbolIndex, SymbolEntry, SymbolKindName } from './symbol-index';
import { DependencyGraph } from './dependency-graph';
import { RepoGraph } from './repo-graph';

export type RelationType =
  | 'import'
  | 'export'
  | 'define'
  | 'call'
  | 'reference'
  | 'implement'
  | 'inherit';

export interface ContextNode {
  id: string;
  filePath: string;
  symbolName: string;
  kind: SymbolKindName;
  relation: RelationType;
  depth: number;
  score: number;
  line: number;
  column: number;
  containerName: string;
  sourceNodeId?: string;
}

export interface ExpansionBudget {
  maxNodes: number;
  maxFiles: number;
  tokenBudget: number;
}

export interface ExpansionOptions {
  relations?: RelationType[];
  budget?: ExpansionBudget;
  intent?: string;
}

export interface ExpansionResult {
  primaryNodes: ContextNode[];
  expandedNodes: ContextNode[];
  allNodes: ContextNode[];
  filesInvolved: string[];
  relationSummary: Record<RelationType, number>;
}

export class ContextExpansionEngine {
  private fileContentCache = new Map<string, string>();

  constructor(
    private readonly symbolIndex: SymbolIndex,
    private readonly dependencyGraph: DependencyGraph,
    private readonly repoGraph: RepoGraph
  ) {}

  async expand(
    primarySymbols: SymbolEntry[],
    options?: ExpansionOptions
  ): Promise<ExpansionResult> {
    const relations = options?.relations ?? [
      'import',
      'export',
      'define',
      'call',
      'reference',
      'implement',
      'inherit',
    ];
    const budget = options?.budget ?? {
      maxNodes: 30,
      maxFiles: 15,
      tokenBudget: 4000,
    };

    // 1. Build Primary Nodes
    const primaryNodes = primarySymbols.map((sym, idx) =>
      this.createNode(sym, 'define', 0, Math.max(100 - idx * 2, 50))
    );

    const allNodes = new Map<string, ContextNode>();
    for (const node of primaryNodes) {
      allNodes.set(node.id, node);
    }

    // 2. Build expansion queue by priority
    const priorityOrder: Record<RelationType, number> = {
      define: 0,
      export: 1,
      import: 2,
      call: 3,
      reference: 4,
      implement: 5,
      inherit: 6,
    };

    const expansionQueue: Array<{ node: ContextNode; relation: RelationType }> = [];
    for (const node of primaryNodes) {
      for (const relation of relations) {
        if (relation === 'define') {
          continue;
        }
        expansionQueue.push({ node, relation });
      }
    }
    expansionQueue.sort(
      (a, b) => priorityOrder[a.relation] - priorityOrder[b.relation]
    );

    // 3. 1-hop expansion
    for (const { node, relation } of expansionQueue) {
      if (this.isBudgetExhausted(allNodes, budget)) {
        break;
      }
      const newNodes = await this.expandRelation(
        node,
        relation,
        budget,
        allNodes
      );
      for (const newNode of newNodes) {
        if (!allNodes.has(newNode.id)) {
          allNodes.set(newNode.id, newNode);
        }
      }
    }

    // 4. 2-hop expansion: expand high-score depth=1 nodes
    const depth1Nodes = Array.from(allNodes.values())
      .filter(n => n.depth === 1)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);

    for (const node of depth1Nodes) {
      for (const relation of relations) {
        if (relation === 'define') {
          continue;
        }
        if (this.isBudgetExhausted(allNodes, budget)) {
          break;
        }
        const newNodes = await this.expandRelation(
          node,
          relation,
          budget,
          allNodes
        );
        for (const newNode of newNodes) {
          if (!allNodes.has(newNode.id)) {
            allNodes.set(newNode.id, newNode);
          }
        }
      }
    }

    // 5. Assemble results
    const nodesArray = Array.from(allNodes.values());
    const expandedNodes = nodesArray.filter(n => n.depth > 0);
    const filesInvolved = [...new Set(nodesArray.map(n => n.filePath))];

    const relationSummary: Record<RelationType, number> = {
      import: 0,
      export: 0,
      define: 0,
      call: 0,
      reference: 0,
      implement: 0,
      inherit: 0,
    };
    for (const node of nodesArray) {
      relationSummary[node.relation]++;
    }

    return {
      primaryNodes,
      expandedNodes,
      allNodes: nodesArray,
      filesInvolved,
      relationSummary,
    };
  }

  private createNode(
    sym: SymbolEntry,
    relation: RelationType,
    depth: number,
    score: number,
    sourceNodeId?: string
  ): ContextNode {
    return {
      id: `${sym.filePath}#${sym.name}@${sym.line}`,
      filePath: sym.filePath,
      symbolName: sym.name,
      kind: sym.kind,
      relation,
      depth,
      score,
      line: sym.line,
      column: sym.column,
      containerName: sym.containerName,
      sourceNodeId,
    };
  }

  private isBudgetExhausted(
    allNodes: Map<string, ContextNode>,
    budget: ExpansionBudget
  ): boolean {
    const nodes = Array.from(allNodes.values());
    const fileCount = new Set(nodes.map(n => n.filePath)).size;
    const estimatedTokens = nodes.length * 15 + fileCount * 50;
    return (
      nodes.length >= budget.maxNodes ||
      fileCount >= budget.maxFiles ||
      estimatedTokens >= budget.tokenBudget
    );
  }

  private async expandRelation(
    node: ContextNode,
    relation: RelationType,
    budget: ExpansionBudget,
    existingNodes: Map<string, ContextNode>
  ): Promise<ContextNode[]> {
    const remainingNodes = budget.maxNodes - existingNodes.size;
    if (remainingNodes <= 0) {
      return [];
    }

    switch (relation) {
      case 'import':
        return this.expandImport(node, remainingNodes, existingNodes);
      case 'export':
        return this.expandExport(node, remainingNodes, existingNodes);
      case 'call':
        return this.expandCall(node, remainingNodes, existingNodes);
      case 'reference':
        return this.expandReference(node, remainingNodes, existingNodes);
      case 'implement':
        return this.expandImplement(node, remainingNodes, existingNodes);
      case 'inherit':
        return this.expandInherit(node, remainingNodes, existingNodes);
      default:
        return [];
    }
  }

  // ===== import expansion =====
  private async expandImport(
    node: ContextNode,
    maxResults: number,
    existingNodes: Map<string, ContextNode>
  ): Promise<ContextNode[]> {
    const results: ContextNode[] = [];
    const deps = this.dependencyGraph.getDependencies(node.filePath);

    for (const depFile of deps.slice(0, 5)) {
      if (results.length >= maxResults) {
        break;
      }
      const importedSymbols = await this.extractImportedSymbols(
        node.filePath,
        depFile
      );
      for (const symName of importedSymbols.slice(0, 3)) {
        const sym = this.findSymbolInFile(depFile, symName);
        if (sym) {
          const id = `${sym.filePath}#${sym.name}@${sym.line}`;
          if (!existingNodes.has(id)) {
            results.push(
              this.createNode(
                sym,
                'import',
                node.depth + 1,
                node.score * 0.7,
                node.id
              )
            );
          }
        }
      }
    }

    return results;
  }

  private async extractImportedSymbols(
    filePath: string,
    depFile: string
  ): Promise<string[]> {
    try {
      const content = await this.readFileContent(filePath);
      const depBaseName =
        depFile
          .replace(/\\/g, '/')
          .split('/')
          .pop()
          ?.replace(/\.[^.]+$/, '') || '';

      const symbols: string[] = [];

      // import { a, b } from '.../depBaseName'
      const namedImportPattern = new RegExp(
        `import\\s*\\{([^}]+)\\}\\s*from\\s*['"][^'"]*${depBaseName}['"]`,
        'g'
      );
      let match: RegExpExecArray | null;
      while ((match = namedImportPattern.exec(content)) !== null) {
        if (match[1]) {
          const names = match[1]
            .split(',')
            .map(s => s.trim())
            .map(s => {
              const parts = s.split(/\s+as\s+/);
              return parts[parts.length - 1].trim();
            })
            .filter(Boolean);
          symbols.push(...names);
        }
      }

      // import x from '.../depBaseName'
      const defaultImportPattern = new RegExp(
        `import\\s+(\\w+)\\s+from\\s*['"][^'"]*${depBaseName}['"]`,
        'g'
      );
      while ((match = defaultImportPattern.exec(content)) !== null) {
        if (match[1]) {
          symbols.push(match[1].trim());
        }
      }

      return [...new Set(symbols)];
    } catch {
      return [];
    }
  }

  private findSymbolInFile(
    filePath: string,
    symbolName: string
  ): SymbolEntry | undefined {
    const symbols = this.symbolIndex.getSymbolsInFile(filePath);
    return symbols.find(
      s => s.name === symbolName || s.name.includes(symbolName)
    );
  }

  // ===== export expansion =====
  private expandExport(
    node: ContextNode,
    maxResults: number,
    existingNodes: Map<string, ContextNode>
  ): ContextNode[] {
    const results: ContextNode[] = [];
    const symbols = this.symbolIndex.getSymbolsInFile(node.filePath);
    const exportKinds = new Set([
      'class',
      'interface',
      'function',
      'enum',
      'type_parameter',
    ]);

    for (const sym of symbols) {
      if (results.length >= maxResults) {
        break;
      }
      if (sym.containerName !== '') {
        continue;
      }
      if (!exportKinds.has(sym.kind)) {
        continue;
      }
      if (sym.name === node.symbolName && sym.line === node.line) {
        continue;
      }

      const id = `${sym.filePath}#${sym.name}@${sym.line}`;
      if (!existingNodes.has(id)) {
        results.push(
          this.createNode(
            sym,
            'export',
            node.depth + 1,
            node.score * 0.6,
            node.id
          )
        );
      }
    }

    return results;
  }

  // ===== call expansion =====
  private async expandCall(
    node: ContextNode,
    maxResults: number,
    existingNodes: Map<string, ContextNode>
  ): Promise<ContextNode[]> {
    if (!['function', 'method'].includes(node.kind)) {
      return [];
    }

    const results: ContextNode[] = [];
    const content = await this.readFileContent(node.filePath);
    const lines = content.split('\n');

    // Get all function/method symbols as candidates
    const allSymbols = this.symbolIndex.search('', 200);
    const candidateFns = allSymbols.filter(
      s =>
        ['function', 'method'].includes(s.kind) &&
        s.name !== node.symbolName &&
        s.filePath !== node.filePath
    );

    // Search function call patterns in current file
    for (let i = 0; i < lines.length; i++) {
      if (results.length >= maxResults) {
        break;
      }
      for (const fn of candidateFns) {
        const callPattern = new RegExp(
          `\\b${this.escapeRegex(fn.name)}\\s*\\(`,
          'g'
        );
        if (callPattern.test(lines[i])) {
          const id = `${fn.filePath}#${fn.name}@${fn.line}`;
          if (!existingNodes.has(id)) {
            results.push(
              this.createNode(
                fn,
                'call',
                node.depth + 1,
                node.score * 0.5,
                node.id
              )
            );
          }
        }
      }
    }

    return results;
  }

  // ===== reference expansion =====
  private expandReference(
    node: ContextNode,
    maxResults: number,
    existingNodes: Map<string, ContextNode>
  ): ContextNode[] {
    const results: ContextNode[] = [];
    const allMatches = this.symbolIndex.search(node.symbolName, 50);

    for (const sym of allMatches) {
      if (results.length >= maxResults) {
        break;
      }
      if (sym.filePath === node.filePath && sym.line === node.line) {
        continue;
      }

      const id = `${sym.filePath}#${sym.name}@${sym.line}`;
      if (!existingNodes.has(id)) {
        results.push(
          this.createNode(
            sym,
            'reference',
            node.depth + 1,
            node.score * 0.4,
            node.id
          )
        );
      }
    }

    return results;
  }

  // ===== implement expansion =====
  private async expandImplement(
    node: ContextNode,
    maxResults: number,
    existingNodes: Map<string, ContextNode>
  ): Promise<ContextNode[]> {
    const results: ContextNode[] = [];

    if (node.kind === 'interface') {
      // Search for classes implementing this interface
      const allNodes = this.dependencyGraph.getAllNodes();
      for (const depNode of allNodes) {
        if (results.length >= maxResults) {
          break;
        }
        const content = await this.readFileContent(depNode.filePath);
        const pattern = new RegExp(
          `implements\\s+${this.escapeRegex(node.symbolName)}\\b`,
          'g'
        );
        if (pattern.test(content)) {
          const symbols = this.symbolIndex.getSymbolsInFile(depNode.filePath);
          const classes = symbols.filter(s => s.kind === 'class');
          for (const cls of classes) {
            const id = `${cls.filePath}#${cls.name}@${cls.line}`;
            if (!existingNodes.has(id)) {
              results.push(
                this.createNode(
                  cls,
                  'implement',
                  node.depth + 1,
                  node.score * 0.6,
                  node.id
                )
              );
            }
          }
        }
      }
    } else if (node.kind === 'class') {
      // Search which interfaces current class implements
      const content = await this.readFileContent(node.filePath);
      const lines = content.split('\n');
      for (
        let i = Math.max(0, node.line - 1);
        i < Math.min(lines.length, node.line + 5);
        i++
      ) {
        const match = lines[i].match(
          /implements\s+([A-Za-z0-9_]+(?:\s*,\s*[A-Za-z0-9_]+)*)/
        );
        if (match) {
          const interfaceNames = match[1].split(',').map(s => s.trim());
          for (const ifaceName of interfaceNames) {
            const ifaceSymbols = this.symbolIndex
              .search(ifaceName, 10)
              .filter(s => s.kind === 'interface');
            for (const sym of ifaceSymbols) {
              const id = `${sym.filePath}#${sym.name}@${sym.line}`;
              if (!existingNodes.has(id)) {
                results.push(
                  this.createNode(
                    sym,
                    'implement',
                    node.depth + 1,
                    node.score * 0.6,
                    node.id
                  )
                );
              }
            }
          }
        }
      }
    }

    return results;
  }

  // ===== inherit expansion =====
  private async expandInherit(
    node: ContextNode,
    maxResults: number,
    existingNodes: Map<string, ContextNode>
  ): Promise<ContextNode[]> {
    const results: ContextNode[] = [];

    if (node.kind === 'class') {
      // Strategy 1: Search for subclasses extending ClassName
      const allNodes = this.dependencyGraph.getAllNodes();
      for (const depNode of allNodes) {
        if (results.length >= maxResults) {
          break;
        }
        const content = await this.readFileContent(depNode.filePath);
        const pattern = new RegExp(
          `extends\\s+${this.escapeRegex(node.symbolName)}\\b`,
          'g'
        );
        if (pattern.test(content)) {
          const symbols = this.symbolIndex.getSymbolsInFile(depNode.filePath);
          const classes = symbols.filter(s => s.kind === 'class');
          for (const cls of classes) {
            const id = `${cls.filePath}#${cls.name}@${cls.line}`;
            if (!existingNodes.has(id)) {
              results.push(
                this.createNode(
                  cls,
                  'inherit',
                  node.depth + 1,
                  node.score * 0.5,
                  node.id
                )
              );
            }
          }
        }
      }

      // Strategy 2: Find what current class inherits
      const content = await this.readFileContent(node.filePath);
      const lines = content.split('\n');
      for (
        let i = Math.max(0, node.line - 1);
        i < Math.min(lines.length, node.line + 5);
        i++
      ) {
        const match = lines[i].match(/extends\s+([A-Za-z0-9_]+)/);
        if (match) {
          const parentName = match[1];
          const parentSymbols = this.symbolIndex
            .search(parentName, 10)
            .filter(s => s.kind === 'class');
          for (const sym of parentSymbols) {
            const id = `${sym.filePath}#${sym.name}@${sym.line}`;
            if (!existingNodes.has(id)) {
              results.push(
                this.createNode(
                  sym,
                  'inherit',
                  node.depth + 1,
                  node.score * 0.5,
                  node.id
                )
              );
            }
          }
        }
      }
    }

    return results;
  }

  // ===== utility methods =====
  private async readFileContent(filePath: string): Promise<string> {
    if (this.fileContentCache.has(filePath)) {
      return this.fileContentCache.get(filePath)!;
    }
    try {
      const uri = vscode.Uri.file(filePath);
      const contentBytes = await vscode.workspace.fs.readFile(uri);
      const content = new TextDecoder().decode(contentBytes);
      this.fileContentCache.set(filePath, content);
      return content;
    } catch {
      return '';
    }
  }

  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}