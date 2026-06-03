import * as vscode from 'vscode';

export type SymbolKindName = 'file' | 'module' | 'namespace' | 'package' | 'class' |
  'method' | 'property' | 'field' | 'constructor' | 'enum' | 'interface' |
  'function' | 'variable' | 'constant' | 'string' | 'number' | 'boolean' |
  'array' | 'object' | 'key' | 'null' | 'enum_member' | 'struct' |
  'event' | 'operator' | 'type_parameter';

export interface SymbolEntry {
  name: string;
  kind: SymbolKindName;
  filePath: string;
  line: number;
  column: number;
  length: number;
  containerName: string;
  detail: string;
}

export interface IndexStats {
  totalFiles: number;
  totalSymbols: number;
  byKind: Record<string, number>;
  byExtension: Record<string, number>;
  lastBuilt: number;
}

export class SymbolIndex {
  private symbols: Map<string, SymbolEntry[]> = new Map();
  private stats: IndexStats = {
    totalFiles: 0,
    totalSymbols: 0,
    byKind: {},
    byExtension: {},
    lastBuilt: 0,
  };

  private readonly KIND_MAP: Record<number, SymbolKindName> = {
    [vscode.SymbolKind.File]: 'file',
    [vscode.SymbolKind.Module]: 'module',
    [vscode.SymbolKind.Namespace]: 'namespace',
    [vscode.SymbolKind.Package]: 'package',
    [vscode.SymbolKind.Class]: 'class',
    [vscode.SymbolKind.Method]: 'method',
    [vscode.SymbolKind.Property]: 'property',
    [vscode.SymbolKind.Field]: 'field',
    [vscode.SymbolKind.Constructor]: 'constructor',
    [vscode.SymbolKind.Enum]: 'enum',
    [vscode.SymbolKind.Interface]: 'interface',
    [vscode.SymbolKind.Function]: 'function',
    [vscode.SymbolKind.Variable]: 'variable',
    [vscode.SymbolKind.Constant]: 'constant',
    [vscode.SymbolKind.String]: 'string',
    [vscode.SymbolKind.Number]: 'number',
    [vscode.SymbolKind.Boolean]: 'boolean',
    [vscode.SymbolKind.Array]: 'array',
    [vscode.SymbolKind.Object]: 'object',
    [vscode.SymbolKind.Key]: 'key',
    [vscode.SymbolKind.Null]: 'null',
    [vscode.SymbolKind.EnumMember]: 'enum_member',
    [vscode.SymbolKind.Struct]: 'struct',
    [vscode.SymbolKind.Event]: 'event',
    [vscode.SymbolKind.Operator]: 'operator',
    [vscode.SymbolKind.TypeParameter]: 'type_parameter',
  };

  private toSymbolKindName(kind: vscode.SymbolKind): SymbolKindName {
    return this.KIND_MAP[kind] || 'variable';
  }

  private flattenSymbols(
    symbols: vscode.DocumentSymbol[],
    filePath: string,
    container: string = ''
  ): SymbolEntry[] {
    const result: SymbolEntry[] = [];

    for (const sym of symbols) {
      result.push({
        name: sym.name,
        kind: this.toSymbolKindName(sym.kind),
        filePath,
        line: sym.range.start.line + 1,
        column: sym.range.start.character + 1,
        length: sym.range.end.character - sym.range.start.character,
        containerName: container,
        detail: sym.detail || '',
      });

      if (sym.children && sym.children.length > 0) {
        const fullContainer = container ? `${container}.${sym.name}` : sym.name;
        result.push(...this.flattenSymbols(sym.children, filePath, fullContainer));
      }
    }

    return result;
  }

  async buildForFile(uri: vscode.Uri): Promise<void> {
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      if (doc.lineCount === 0) return;

      const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
        'vscode.executeDocumentSymbolProvider',
        uri
      );

      if (symbols && symbols.length > 0) {
        this.symbols.set(uri.fsPath, this.flattenSymbols(symbols, uri.fsPath));
      } else {
        this.symbols.delete(uri.fsPath);
      }
    } catch {
      this.symbols.delete(uri.fsPath);
    }
  }

  async buildForFiles(uris: vscode.Uri[], onProgress?: (done: number, total: number) => void): Promise<void> {
    const total = uris.length;
    for (let i = 0; i < total; i++) {
      await this.buildForFile(uris[i]);
      onProgress?.(i + 1, total);
    }
    this.updateStats();
  }

  async rebuildAll(filePaths: string[]): Promise<void> {
    this.symbols.clear();
    const uris = filePaths.map(p => vscode.Uri.file(p));
    await this.buildForFiles(uris);
  }

  removeFile(filePath: string): void {
    this.symbols.delete(filePath);
    this.updateStats();
  }

  private updateStats(): void {
    let totalSymbols = 0;
    const byKind: Record<string, number> = {};
    const byExtension: Record<string, number> = {};

    for (const [filePath, entries] of this.symbols) {
      const ext = filePath.substring(filePath.lastIndexOf('.'));
      byExtension[ext] = (byExtension[ext] || 0) + 1;

      for (const entry of entries) {
        totalSymbols++;
        byKind[entry.kind] = (byKind[entry.kind] || 0) + 1;
      }
    }

    this.stats = {
      totalFiles: this.symbols.size,
      totalSymbols,
      byKind,
      byExtension,
      lastBuilt: Date.now(),
    };
  }

  search(query: string, maxResults: number = 20): SymbolEntry[] {
    const lowerQuery = query.toLowerCase();
    const results: { entry: SymbolEntry; score: number }[] = [];

    for (const entries of this.symbols.values()) {
      for (const entry of entries) {
        const lowerName = entry.name.toLowerCase();
        let score = 0;

        if (lowerName === lowerQuery) {
          score = 100;
        } else if (lowerName === `${lowerQuery}` || entry.name.endsWith(query)) {
          score = 80;
        } else if (lowerName.includes(lowerQuery)) {
          score = 60 - Math.abs(entry.name.length - query.length) * 2;
        } else if (entry.containerName.toLowerCase().includes(lowerQuery)) {
          score = 30;
        }

        if (score > 0) {
          results.push({ entry, score });
        }
      }
    }

    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults)
      .map(r => r.entry);
  }

  searchByKind(kind: SymbolKindName, query?: string, maxResults: number = 50): SymbolEntry[] {
    const results: SymbolEntry[] = [];

    for (const entries of this.symbols.values()) {
      for (const entry of entries) {
        if (entry.kind !== kind) continue;
        if (query && !entry.name.toLowerCase().includes(query.toLowerCase())) continue;
        results.push(entry);
      }
    }

    return results.slice(0, maxResults);
  }

  getSymbolsInFile(filePath: string): SymbolEntry[] {
    return this.symbols.get(filePath) || [];
  }

  getSymbolsByContainer(containerName: string, maxResults: number = 30): SymbolEntry[] {
    const results: SymbolEntry[] = [];
    for (const entries of this.symbols.values()) {
      for (const entry of entries) {
        if (entry.containerName === containerName || entry.containerName.startsWith(`${containerName}.`)) {
          results.push(entry);
        }
      }
    }
    return results.slice(0, maxResults);
  }

  findClasses(query?: string): SymbolEntry[] {
    return this.searchByKind('class', query);
  }

  findFunctions(query?: string): SymbolEntry[] {
    return this.searchByKind('function', query);
  }

  findInterfaces(query?: string): SymbolEntry[] {
    return this.searchByKind('interface', query);
  }

  isBuilt(): boolean {
    return this.symbols.size > 0 && this.stats.totalFiles > 0;
  }

  getStats(): IndexStats {
    return { ...this.stats };
  }
}