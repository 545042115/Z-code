import * as vscode from 'vscode';
import { WorkspaceScanner, WorkspaceFile } from './workspaceScanner';

export interface DependencyEdge {
  from: string;
  to: string;
  importType: 'static' | 'dynamic' | 'require';
}

export interface DependencyNode {
  filePath: string;
  extension: string;
  size: number;
  dependencies: string[];
  dependents: string[];
  isEntryPoint: boolean;
  isExternal: boolean;
}

export class DependencyGraph {
  private nodes: Map<string, DependencyNode> = new Map();
  private edges: DependencyEdge[] = [];
  private built = false;
  private normalizedPathMap: Map<string, string> = new Map();

  /**
   * 返回新的正则实例，避免带 g 标志的正则在并发调用中共享 lastIndex 导致竞态条件。
   */
  private getImportPatterns(): RegExp[] {
    return [
      /import\s+(?:(?:\{[^}]*\}|[^;{]+)\s+from\s+)?['"]([^'"]+)['"]/g,
      /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
      /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
      /export\s*\*\s*from\s+['"]([^'"]+)['"]/g,
      /import\s+type\s+(?:(?:\{[^}]*\}|[^;{]+)\s+from\s+)?['"]([^'"]+)['"]/g,
    ];
  }

  constructor(private readonly scanner: WorkspaceScanner) {}

  get isBuilt(): boolean {
    return this.built;
  }

  async build(): Promise<void> {
    this.nodes.clear();
    this.edges = [];

    const files = this.scanner.getSourceFiles();

    for (const file of files) {
      if (!this.nodes.has(file.path)) {
        this.nodes.set(file.path, {
          filePath: file.path,
          extension: file.extension,
          size: file.size,
          dependencies: [],
          dependents: [],
          isEntryPoint: this.isEntryPoint(file),
          isExternal: false,
        });
      }
    }

    this.normalizedPathMap.clear();
    for (const key of this.nodes.keys()) {
      this.normalizedPathMap.set(key.replace(/\\/g, '/'), key);
    }

    const parseResults = await Promise.all(
      files.map(async file => ({ file, deps: await this.parseImports(file) }))
    );

    for (const { file, deps } of parseResults) {
      const node = this.nodes.get(file.path)!;

      for (const rawImport of deps) {
        const resolved = this.resolvePath(file.path, rawImport);
        if (resolved && this.nodes.has(resolved)) {
          node.dependencies.push(resolved);
          this.nodes.get(resolved)!.dependents.push(file.path);
          this.edges.push({ from: file.path, to: resolved, importType: 'static' });
        }
      }
    }

    this.built = true;
  }

  getDependencies(filePath: string): string[] {
    return this.nodes.get(filePath)?.dependencies || [];
  }

  getDependents(filePath: string): string[] {
    return this.nodes.get(filePath)?.dependents || [];
  }

  getNode(filePath: string): DependencyNode | undefined {
    return this.nodes.get(filePath);
  }

  getAllNodes(): DependencyNode[] {
    return Array.from(this.nodes.values());
  }

  getTransitiveDependents(filePath: string, maxDepth: number = 3): { file: string; depth: number }[] {
    const result: { file: string; depth: number }[] = [];
    const visited = new Set<string>();
    const queue: { file: string; depth: number }[] = [{ file: filePath, depth: 0 }];
    visited.add(filePath);

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current.depth > 0) {
        result.push(current);
      }
      if (current.depth >= maxDepth) continue;

      const dependents = this.getDependents(current.file);
      for (const dep of dependents) {
        if (!visited.has(dep)) {
          visited.add(dep);
          queue.push({ file: dep, depth: current.depth + 1 });
        }
      }
    }

    return result;
  }

  getTransitiveDependencies(filePath: string, maxDepth: number = 3): { file: string; depth: number }[] {
    const result: { file: string; depth: number }[] = [];
    const visited = new Set<string>();
    const queue: { file: string; depth: number }[] = [{ file: filePath, depth: 0 }];
    visited.add(filePath);

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current.depth > 0) {
        result.push(current);
      }
      if (current.depth >= maxDepth) continue;

      const deps = this.getDependencies(current.file);
      for (const dep of deps) {
        if (!visited.has(dep)) {
          visited.add(dep);
          queue.push({ file: dep, depth: current.depth + 1 });
        }
      }
    }

    return result;
  }

  getCriticalFiles(limit: number = 10): { filePath: string; dependentCount: number }[] {
    return Array.from(this.nodes.values())
      .map(n => ({ filePath: n.filePath, dependentCount: n.dependents.length }))
      .filter(n => n.dependentCount > 0)
      .sort((a, b) => b.dependentCount - a.dependentCount)
      .slice(0, limit);
  }

  getIslands(): string[][] {
    const visited = new Set<string>();
    const islands: string[][] = [];

    for (const filePath of this.nodes.keys()) {
      if (visited.has(filePath)) continue;

      const island: string[] = [];
      const queue = [filePath];
      visited.add(filePath);

      while (queue.length > 0) {
        const current = queue.shift()!;
        island.push(current);

        const deps = this.getDependencies(current);
        const depents = this.getDependents(current);
        const all = [...new Set([...deps, ...depents])];

        for (const neighbor of all) {
          if (!visited.has(neighbor)) {
            visited.add(neighbor);
            queue.push(neighbor);
          }
        }
      }

      islands.push(island);
    }

    return islands;
  }

  toJSON(): { nodes: DependencyNode[]; edges: DependencyEdge[] } {
    return {
      nodes: this.getAllNodes(),
      edges: this.edges,
    };
  }

  formatForPrompt(filePath?: string, maxDepth: number = 2): string {
    if (!this.built) return '(dependency graph not built)';

    if (filePath) {
      const node = this.nodes.get(filePath);
      if (!node) return `File not found in graph: ${filePath}`;

      const lines: string[] = [`File: ${this.shortenPath(filePath)}`];
      lines.push(`  Dependencies (${node.dependencies.length}):`);
      for (const dep of node.dependencies.slice(0, 10)) {
        const n = this.nodes.get(dep);
        const depCount = n ? n.dependents.length : 0;
        lines.push(`    ← ${this.shortenPath(dep)} (used by ${depCount} files)`);
      }
      if (node.dependencies.length > 10) {
        lines.push(`    ... and ${node.dependencies.length - 10} more`);
      }

      const transitive = this.getTransitiveDependents(filePath, maxDepth);
      lines.push(`  Impact scope (${transitive.length} transitive dependents):`);
      for (const t of transitive.slice(0, 10)) {
        lines.push(`    depth ${t.depth}: ${this.shortenPath(t.file)}`);
      }
      if (transitive.length > 10) {
        lines.push(`    ... and ${transitive.length - 10} more`);
      }

      return lines.join('\n');
    }

    const critical = this.getCriticalFiles(5);
    const lines: string[] = [
      `Dependency Graph: ${this.nodes.size} files, ${this.edges.length} edges`,
      `Critical files (most dependents):`,
    ];
    for (const c of critical) {
      lines.push(`  ${this.shortenPath(c.filePath)} — ${c.dependentCount} dependents`);
    }

    const islands = this.getIslands();
    if (islands.length > 1) {
      lines.push(`\nWarning: ${islands.length} disconnected subgraphs detected`);
    }

    return lines.join('\n');
  }

  private async parseImports(file: WorkspaceFile): Promise<string[]> {
    try {
      const uri = vscode.Uri.file(file.path);
      const content = await vscode.workspace.fs.readFile(uri);
      const text = new TextDecoder().decode(content);

      const imports = new Set<string>();
      for (const pattern of this.getImportPatterns()) {
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(text)) !== null) {
          imports.add(match[1]);
        }
      }

      return Array.from(imports);
    } catch {
      return [];
    }
  }

  private resolvePath(fromFile: string, importPath: string): string | null {
    if (!importPath.startsWith('.') && !importPath.startsWith('/')) {
      return null;
    }

    const normalizedFrom = fromFile.replace(/\\/g, '/');
    const dir = normalizedFrom.substring(0, normalizedFrom.lastIndexOf('/'));

    let resolved: string;
    if (importPath.startsWith('/')) {
      resolved = importPath;
    } else {
      const parts = importPath.split('/');
      const dirParts = dir.split('/');
      for (const part of parts) {
        if (part === '.') continue;
        if (part === '..') { dirParts.pop(); continue; }
        dirParts.push(part);
      }
      resolved = dirParts.join('/');
    }

    const extensions = ['', '.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs', '.cts', '.cjs', '.d.ts', '/index.ts', '/index.tsx', '/index.js', '/index.jsx'];

    const normalizedToActual = this.normalizedPathMap;

    for (const ext of extensions) {
      const candidate = resolved + ext;
      if (normalizedToActual.has(candidate)) {
        return normalizedToActual.get(candidate)!;
      }
    }

    return null;
  }

  private isEntryPoint(file: WorkspaceFile): boolean {
    const name = file.path.split(/[/\\]/).pop() || '';
    return name === 'main.ts' || name === 'main.js' || name === 'index.ts' || name === 'index.js' ||
      name === 'app.ts' || name === 'app.js' || file.path.includes('entry') || file.path.includes('cli');
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