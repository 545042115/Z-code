import * as vscode from 'vscode';
import { WorkspaceScanner, WorkspaceFile } from './workspace-scanner';
import { SymbolIndex, SymbolEntry } from './symbol-index';
import { DependencyGraph, DependencyNode } from './dependency-graph';

export interface DirectoryNode {
  name: string;
  path: string;
  type: 'directory' | 'file';
  children: DirectoryNode[];
  fileCount: number;
  symbolCount: number;
  topSymbols: string[];
  isEntryPoint: boolean;
}

export interface RepoMapEntry {
  path: string;
  type: 'directory' | 'file';
  summary: string;
  symbols: { name: string; kind: string }[];
  dependentCount: number;
}

export class RepoMap {
  private tree: DirectoryNode | null = null;
  private built = false;

  constructor(
    private readonly scanner: WorkspaceScanner,
    private readonly symbolIndex: SymbolIndex,
    private readonly dependencyGraph: DependencyGraph
  ) {}

  get isBuilt(): boolean {
    return this.built;
  }

  async build(): Promise<void> {
    this.tree = this.buildTree();
    this.built = true;
  }

  formatAsciiTree(maxDepth: number = 4): string {
    if (!this.tree) return '(repo map not built)';
    const lines: string[] = [];
    this.renderTree(this.tree, '', true, lines, 0, maxDepth);
    return lines.join('\n');
  }

  getEntryPoints(): { path: string; symbols: SymbolEntry[] }[] {
    const result: { path: string; symbols: SymbolEntry[] }[] = [];
    const nodes = this.dependencyGraph.getAllNodes();
    for (const node of nodes) {
      if (node.isEntryPoint || node.dependents.length === 0) {
        const symbols = this.symbolIndex.getSymbolsInFile(node.filePath);
        if (symbols.length > 0) {
          result.push({ path: node.filePath, symbols: symbols.slice(0, 10) });
        }
      }
    }
    return result;
  }

  getDirectorySummary(dirPath?: string): string {
    const files = dirPath
      ? this.scanner.getFilesInDirectory(dirPath)
      : this.scanner.getSourceFiles();

    const totalSymbols = files.reduce((sum, f) =>
      sum + this.symbolIndex.getSymbolsInFile(f.path).length, 0
    );

    const extensions = new Map<string, number>();
    for (const f of files) {
      extensions.set(f.extension, (extensions.get(f.extension) || 0) + 1);
    }

    return [
      `Files: ${files.length}`,
      `Symbols: ${totalSymbols}`,
      `Types: ${Array.from(extensions.entries()).map(([k, v]) => `${k}:${v}`).join(', ')}`,
    ].join('\n');
  }

  getAllModules(): { directory: string; fileCount: number; symbolCount: number; exports: string[] }[] {
    const dirMap = new Map<string, { files: string[]; symbols: SymbolEntry[] }>();

    for (const node of this.dependencyGraph.getAllNodes()) {
      const dir = node.filePath.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
      if (!dirMap.has(dir)) {
        dirMap.set(dir, { files: [], symbols: [] });
      }
      dirMap.get(dir)!.files.push(node.filePath);
      const syms = this.symbolIndex.getSymbolsInFile(node.filePath);
      dirMap.get(dir)!.symbols.push(...syms);
    }

    return Array.from(dirMap.entries())
      .map(([dir, data]) => ({
        directory: dir,
        fileCount: data.files.length,
        symbolCount: data.symbols.length,
        exports: data.symbols
          .filter(s => s.containerName === '' && ['class', 'interface', 'function', 'enum'].includes(s.kind))
          .slice(0, 20)
          .map(s => s.name),
      }))
      .sort((a, b) => b.fileCount - a.fileCount);
  }

  formatForPrompt(maxDepth: number = 3): string {
    if (!this.built) return '(repo map not built)';

    const parts: string[] = ['## Repository Map\n'];

    parts.push('### Directory Structure\n');
    parts.push(this.formatAsciiTree(maxDepth));
    parts.push('');

    const entryPoints = this.getEntryPoints();
    if (entryPoints.length > 0) {
      parts.push('### Entry Points\n');
      for (const ep of entryPoints.slice(0, 5)) {
        const names = ep.symbols.map(s => `${s.name} [${s.kind}]`).join(', ');
        parts.push(`  ${this.shortenPath(ep.path)} → ${names}`);
      }
      parts.push('');
    }

    const critical = this.dependencyGraph.getCriticalFiles(5);
    if (critical.length > 0) {
      parts.push('### Critical Files (most dependents)\n');
      for (const c of critical) {
        parts.push(`  ${this.shortenPath(c.filePath)} → ${c.dependentCount} dependents`);
      }
      parts.push('');
    }

    const modules = this.getAllModules();
    if (modules.length > 0) {
      parts.push('### Modules Overview\n');
      for (const mod of modules.slice(0, 15)) {
        const dirName = this.shortenPath(mod.directory);
        const topExports = mod.exports.slice(0, 5).join(', ');
        parts.push(`  ${dirName}/ → ${mod.fileCount} files, ${mod.symbolCount} symbols`);
        if (topExports) {
          parts.push(`    exports: ${topExports}${mod.exports.length > 5 ? '...' : ''}`);
        }
      }
    }

    return parts.join('\n');
  }

  private buildTree(): DirectoryNode {
    const root: DirectoryNode = {
      name: '',
      path: '',
      type: 'directory',
      children: [],
      fileCount: 0,
      symbolCount: 0,
      topSymbols: [],
      isEntryPoint: false,
    };

    const files = this.scanner.getSourceFiles();
    const dirMap = new Map<string, DirectoryNode>();
    dirMap.set('', root);

    for (const file of files) {
      const parts = file.path.replace(/\\/g, '/').split('/');
      let currentPath = '';

      for (let i = 0; i < parts.length; i++) {
        const parentPath = currentPath;
        currentPath = currentPath ? `${currentPath}/${parts[i]}` : parts[i];

        if (!dirMap.has(currentPath)) {
          const isDir = i < parts.length - 1;
          const node: DirectoryNode = {
            name: parts[i],
            path: currentPath,
            type: isDir ? 'directory' : 'file',
            children: [],
            fileCount: 0,
            symbolCount: 0,
            topSymbols: [],
            isEntryPoint: false,
          };
          dirMap.set(currentPath, node);
          dirMap.get(parentPath)!.children.push(node);
        }

        if (i === parts.length - 1) {
          const node = dirMap.get(currentPath)!;
          const symbols = this.symbolIndex.getSymbolsInFile(file.path);
          node.symbolCount = symbols.length;
          node.topSymbols = symbols
            .filter(s => ['class', 'interface', 'function', 'enum'].includes(s.kind))
            .slice(0, 5)
            .map(s => s.name);
          node.isEntryPoint = this.dependencyGraph.getNode(file.path)?.isEntryPoint || false;
        }
      }
    }

    this.aggregateCounts(root);
    return root;
  }

  private aggregateCounts(node: DirectoryNode): void {
    for (const child of node.children) {
      this.aggregateCounts(child);
      if (child.type === 'directory') {
        node.fileCount += child.fileCount;
        node.symbolCount += child.symbolCount;
      } else {
        node.fileCount += 1;
        node.symbolCount += child.symbolCount;
      }
    }
  }

  private renderTree(
    node: DirectoryNode,
    prefix: string,
    isLast: boolean,
    lines: string[],
    depth: number,
    maxDepth: number
  ): void {
    if (depth > maxDepth) return;

    if (depth > 0) {
      const connector = isLast ? '鈹斺攢鈹€ ' : '鈹溾攢鈹€ ';
      const icon = node.type === 'directory' ? '馃搧' : '馃搫';
      let label = `${icon} ${node.name}`;
      if (node.type === 'directory' && node.fileCount > 0) {
        label += ` (${node.fileCount} files, ${node.symbolCount} symbols)`;
      }
      if (node.type === 'file' && node.topSymbols.length > 0) {
        label += ` [${node.topSymbols.join(', ')}]`;
      }
      if (node.isEntryPoint) {
        label += ' *';
      }
      lines.push(`${prefix}${connector}${label}`);
    }

    if (node.type === 'directory') {
      const children = node.children;
      for (let i = 0; i < children.length; i++) {
        const child = children[i];
        const newPrefix = depth === 0 ? '' : prefix + (isLast ? '    ' : '鈹?  ');
        this.renderTree(child, newPrefix, i === children.length - 1, lines, depth + 1, maxDepth);
      }
    }
  }

  private shortenPath(filePath: string): string {
    const parts = filePath.replace(/\\/g, '/').split('/');
    const srcIndex = parts.lastIndexOf('src');
    if (srcIndex >= 0) {
      const sliced = parts.slice(srcIndex + 1);
      if (sliced.length > 0) return sliced.join('/');
      return parts[srcIndex];
    }
    if (parts.length <= 3) return parts.join('/');
    return parts.slice(-3).join('/');
  }
}