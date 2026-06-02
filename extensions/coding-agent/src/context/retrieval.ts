import * as vscode from 'vscode';
import { WorkspaceScanner, WorkspaceFile } from './workspaceScanner';
import { SymbolIndex, SymbolEntry } from './symbolIndex';

export interface RelevantResult {
  type: 'symbol' | 'file' | 'directory';
  relevance: number;
  label: string;
  description: string;
  location?: { filePath: string; line: number; column: number };
}

export class Retrieval {
  constructor(
    private readonly scanner: WorkspaceScanner,
    private readonly symbolIndex: SymbolIndex
  ) {}

  async findRelevantCode(query: string, maxResults: number = 15): Promise<RelevantResult[]> {
    const results: RelevantResult[] = [];
    const lowerQuery = query.toLowerCase();

    const symbolResults = this.symbolIndex.search(query, maxResults);
    for (const sym of symbolResults) {
      results.push({
        type: 'symbol',
        relevance: 90 - results.length * 2,
        label: sym.name,
        description: `${sym.kind} in ${this.shortenPath(sym.filePath)}${sym.containerName ? ` › ${sym.containerName}` : ''}`,
        location: { filePath: sym.filePath, line: sym.line, column: sym.column },
      });
    }

    const matchedFiles = this.scanner.getFiles().filter(f => {
      const fileName = f.path.split('/').pop()?.split('\\').pop() || '';
      return fileName.toLowerCase().includes(lowerQuery);
    });

    for (const file of matchedFiles) {
      if (results.length >= maxResults) break;
      if (results.some(r => r.location?.filePath === file.path)) continue;

      results.push({
        type: 'file',
        relevance: 50,
        label: file.path.split('/').pop()?.split('\\').pop() || '',
        description: this.shortenPath(file.path),
      });
    }

    return results.slice(0, maxResults);
  }

  async findFilesByPattern(pattern: string): Promise<WorkspaceFile[]> {
    const lowerPattern = pattern.toLowerCase();
    return this.scanner.getFiles().filter(f => {
      const fileName = f.path.split('/').pop()?.split('\\').pop() || '';
      return fileName.toLowerCase().includes(lowerPattern) ||
        f.path.toLowerCase().includes(lowerPattern);
    });
  }

  async findRelatedFiles(filePath: string, maxResults: number = 10): Promise<WorkspaceFile[]> {
    const related: WorkspaceFile[] = [];
    const seen = new Set<string>();
    seen.add(filePath);

    const dir = filePath.substring(0, Math.max(
      filePath.lastIndexOf('/'),
      filePath.lastIndexOf('\\')
    ));

    const dirFiles = this.scanner.getFilesInDirectory(dir).filter(f => !seen.has(f.path));
    for (const f of dirFiles.slice(0, 5)) {
      related.push(f);
      seen.add(f.path);
    }

    const symbols = this.symbolIndex.getSymbolsInFile(filePath);
    for (const sym of symbols) {
      if (related.length >= maxResults) break;
      const relatedSymbols = this.symbolIndex.getSymbolsByContainer(sym.containerName);
      for (const rs of relatedSymbols) {
        if (!seen.has(rs.filePath)) {
          const file = this.scanner.getFiles().find(f => f.path === rs.filePath);
          if (file) {
            related.push(file);
            seen.add(rs.filePath);
          }
        }
      }
    }

    const recentFiles = this.scanner.getRecentlyModified(10);
    for (const f of recentFiles) {
      if (related.length >= maxResults) break;
      if (!seen.has(f.path)) {
        related.push(f);
        seen.add(f.path);
      }
    }

    return related.slice(0, maxResults);
  }

  async summarizeWorkspace(): Promise<string> {
    const info = this.scanner.getFiles();
    const stats = this.symbolIndex.getStats();
    const sourceFiles = this.scanner.getSourceFiles();

    const extGroups = new Map<string, number>();
    for (const f of sourceFiles) {
      extGroups.set(f.extension, (extGroups.get(f.extension) || 0) + 1);
    }

    const extSummary = Array.from(extGroups.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([ext, count]) => `${ext}: ${count}`)
      .join(', ');

    const dirs = new Set(sourceFiles.map(f =>
      f.path.replace(/\\/g, '/').split('/').slice(0, -1).join('/')
    ));

    return [
      `Total files: ${info.length}`,
      `Source files: ${sourceFiles.length}`,
      `Directories: ${dirs.size}`,
      `Symbols indexed: ${stats.totalSymbols}`,
      `File types: ${extSummary}`,
      `Last indexed: ${new Date(stats.lastBuilt).toLocaleTimeString()}`,
    ].join('\n');
  }

  private shortenPath(filePath: string): string {
    const parts = filePath.replace(/\\/g, '/').split('/');
    if (parts.length <= 3) return parts.join('/');
    return `.../${parts.slice(-3).join('/')}`;
  }
}