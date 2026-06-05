import { WorkspaceScanner } from './workspaceScanner';
import { SymbolIndex, SymbolEntry } from './symbolIndex';
import { DependencyGraph, DependencyNode } from './dependencyGraph';

export interface GraphNode {
  id: string;
  name: string;
  path: string;
  type: 'file' | 'module' | 'server' | 'entry_point' | 'core' | 'ui' | 'config' | 'build';
  moduleTag: string;
  symbols: SymbolEntry[];
  fileCount?: number;
}

export interface GraphEdge {
  source: string;
  target: string;
  type: 'import' | 'call' | 'data_flow';
  weight: number;
}

export interface DataFlowPath {
  from: string;
  to: string;
  through: string[];
  description: string;
}

export interface ModuleHierarchy {
  name: string;
  type: string;
  children: ModuleHierarchy[];
  files: string[];
}

export interface RepoGraphOutput {
  nodes: GraphNode[];
  edges: GraphEdge[];
  dataFlows: DataFlowPath[];
  hierarchy: ModuleHierarchy;
  dependencyOverview: string;
}

export class RepoGraph {
  private nodes: GraphNode[] = [];
  private edges: GraphEdge[] = [];
  private dataFlows: DataFlowPath[] = [];
  private nodeById: Map<string, GraphNode> = new Map();
  private adjacencyList: Map<string, string[]> = new Map();
  private built = false;

  private readonly MODULE_PATTERNS: { tag: string; type: GraphNode['type']; patterns: RegExp[] }[] = [
    {
      tag: 'server',
      type: 'server',
      patterns: [/server/, /api/, /route/, /controller/, /handler/, /middleware/],
    },
    {
      tag: 'core',
      type: 'core',
      patterns: [/core/, /util/, /helper/, /common/, /shared/, /base/, /lib/],
    },
    {
      tag: 'ui',
      type: 'ui',
      patterns: [/ui/, /component/, /view/, /page/, /screen/, /layout/, /panel/, /widget/],
    },
    {
      tag: 'config',
      type: 'config',
      patterns: [/config/, /setting/, /env/, /\.env/],
    },
    {
      tag: 'build',
      type: 'build',
      patterns: [/webpack/, /vite/, /rollup/, /esbuild/, /gulp/, /grunt/],
    },
  ];

  constructor(
    private readonly scanner: WorkspaceScanner,
    private readonly symbolIndex: SymbolIndex,
    private readonly dependencyGraph: DependencyGraph
  ) {}

  get isBuilt(): boolean {
    return this.built;
  }

  build(): void {
    this.nodes = [];
    this.edges = [];
    this.dataFlows = [];
    this.nodeById = new Map();
    this.adjacencyList = new Map();

    const allNodes = this.dependencyGraph.getAllNodes();
    const sourceFiles = this.scanner.getSourceFiles();

    for (const file of sourceFiles) {
      const node = allNodes.find(n => n.filePath === file.path);
      const moduleInfo = this.classifyModule(file.path);
      const symbols = this.symbolIndex.getSymbolsInFile(file.path).slice(0, 15);

      const graphNode: GraphNode = {
        id: file.path,
        name: file.path.split(/[/\\]/).pop() || file.path,
        path: file.path,
        type: moduleInfo.type,
        moduleTag: moduleInfo.tag,
        symbols,
        fileCount: 1,
      };

      if (node?.isEntryPoint) {
        graphNode.type = 'entry_point';
        graphNode.moduleTag = 'entry';
      }

      this.nodes.push(graphNode);
      this.nodeById.set(graphNode.id, graphNode);
      this.adjacencyList.set(graphNode.id, []);
    }

    for (const node of allNodes) {
      const srcId = node.filePath;
      if (!this.nodeById.has(srcId)) continue;

      for (const dep of node.dependencies) {
        if (!this.nodeById.has(dep)) continue;
        this.edges.push({
          source: srcId,
          target: dep,
          type: 'import',
          weight: 1,
        });
        this.adjacencyList.get(srcId)!.push(dep);
      }
    }

    this.buildDataFlows();
    this.built = true;
  }

  getModuleHierarchy(): ModuleHierarchy {
    const root: ModuleHierarchy = {
      name: 'Project',
      type: 'root',
      children: [],
      files: [],
    };

    const moduleMap = new Map<string, ModuleHierarchy>();

    for (const node of this.nodes) {
      const tag = node.moduleTag;
      if (!moduleMap.has(tag)) {
        moduleMap.set(tag, {
          name: tag,
          type: node.type,
          children: [],
          files: [],
        });
      }
      moduleMap.get(tag)!.files.push(node.name);
    }

    for (const [, mod] of moduleMap) {
      const subDirs = new Map<string, string[]>();
      for (const file of mod.files) {
        const parts = file.split(/[/\\]/);
        if (parts.length > 1) {
          const dir = parts[0];
          if (!subDirs.has(dir)) subDirs.set(dir, []);
          subDirs.get(dir)!.push(file);
        }
      }
      for (const [dir, files] of subDirs) {
        if (files.length > 1) {
          mod.children.push({
            name: dir,
            type: 'submodule',
            children: [],
            files: files,
          });
        }
      }
      if (mod.children.length === 0) {
        mod.children = mod.files.slice(0, 10).map(f => ({
          name: f,
          type: 'file',
          children: [],
          files: [f],
        }));
      }
      root.children.push(mod);
    }

    return root;
  }

  getDependencyOverview(): string {
    if (!this.built) return '(repo graph not built)';

    const parts: string[] = ['## Repository Dependency Overview\n'];

    const layerModules = new Map<GraphNode['type'], GraphNode[]>();
    for (const node of this.nodes) {
      if (!layerModules.has(node.type)) {
        layerModules.set(node.type, []);
      }
      layerModules.get(node.type)!.push(node);
    }

    parts.push('### Module Layers\n');
    const layerOrder: GraphNode['type'][] = ['entry_point', 'server', 'core', 'ui', 'config', 'build', 'file'];
    for (const layer of layerOrder) {
      const mods = layerModules.get(layer);
      if (mods && mods.length > 0) {
        const count = mods.length;
        const sample = mods.slice(0, 5).map(m => m.name).join(', ');
        parts.push(`  ${layer} (${count} files): ${sample}${count > 5 ? '...' : ''}`);
      }
    }
    parts.push('');

    parts.push('### Data Flow Direction\n');
    parts.push('  Request → Entry Point → Server Layer → Core Layer → Response');
    parts.push('  UI Layer → Server Layer → Core Layer → Data');
    parts.push('  Config/Build → All Layers (cross-cutting)\n');

    if (this.dataFlows.length > 0) {
      parts.push('### Key Data Flows\n');
      for (const flow of this.dataFlows.slice(0, 5)) {
        const pathStr = flow.through.map(t => this.shortenName(t)).join(' → ');
        parts.push(`  ${this.shortenName(flow.from)} → ${pathStr} → ${this.shortenName(flow.to)}`);
        parts.push(`    ${flow.description}`);
      }
      parts.push('');
    }

    return parts.join('\n');
  }

  formatForPrompt(): string {
    if (!this.built) return '(repo graph not built)';

    const parts: string[] = ['## RepoGraph: Module Dependency & Data Flow\n'];

    parts.push(this.getDependencyOverview());

    const hierarchy = this.getModuleHierarchy();
    parts.push('### Module Hierarchy\n');
    this.renderHierarchy(hierarchy, '', true, parts, 0, 3);

    parts.push('### Cross-Module Dependencies\n');

    const crossEdges = this.getCrossModuleEdges();
    const edgeSummary = new Map<string, { count: number; files: string[] }>();

    for (const edge of crossEdges) {
      const sourceNode = this.nodes.find(n => n.id === edge.source);
      const targetNode = this.nodes.find(n => n.id === edge.target);
      if (!sourceNode || !targetNode) continue;

      const key = `${sourceNode.moduleTag}→${targetNode.moduleTag}`;
      if (!edgeSummary.has(key)) {
        edgeSummary.set(key, { count: 0, files: [] });
      }
      const entry = edgeSummary.get(key)!;
      entry.count++;
      if (entry.files.length < 3) {
        entry.files.push(`${sourceNode.name} → ${targetNode.name}`);
      }
    }

    const sortedEdges = Array.from(edgeSummary.entries()).sort((a, b) => b[1].count - a[1].count);
    for (const [key, info] of sortedEdges.slice(0, 10)) {
      parts.push(`  ${key} (${info.count} edges)`);
      for (const f of info.files) {
        parts.push(`    ${f}`);
      }
    }

    return parts.join('\n');
  }

  getNode(filePath: string): GraphNode | undefined {
    return this.nodeById.get(filePath);
  }

  getNodesByType(type: GraphNode['type']): GraphNode[] {
    return this.nodes.filter(n => n.type === type);
  }

  getNodesByModule(tag: string): GraphNode[] {
    return this.nodes.filter(n => n.moduleTag === tag);
  }

  getEdgesForNode(filePath: string): { incoming: GraphEdge[]; outgoing: GraphEdge[] } {
    return {
      incoming: this.edges.filter(e => e.target === filePath),
      outgoing: this.edges.filter(e => e.source === filePath),
    };
  }

  private classifyModule(filePath: string): { tag: string; type: GraphNode['type'] } {
    const lower = filePath.replace(/\\/g, '/').toLowerCase();

    for (const mod of this.MODULE_PATTERNS) {
      for (const pat of mod.patterns) {
        if (pat.test(lower)) {
          return { tag: mod.tag, type: mod.type };
        }
      }
    }

    return { tag: 'other', type: 'file' };
  }

  private buildDataFlows(): void {
    const entryNodes = this.nodes.filter(n => n.type === 'entry_point');
    const serverNodes = this.nodes.filter(n => n.type === 'server');
    const coreNodes = this.nodes.filter(n => n.type === 'core');

    for (const entry of entryNodes) {
      for (const server of serverNodes) {
        if (this.hasPath(entry.id, server.id)) {
          const through = this.findShortestPath(entry.id, server.id);
          this.dataFlows.push({
            from: entry.id,
            to: server.id,
            through,
            description: `Request entry → server handler`,
          });
        }
      }
    }

    for (const server of serverNodes) {
      for (const core of coreNodes) {
        if (this.hasPath(server.id, core.id)) {
          const through = this.findShortestPath(server.id, core.id);
          this.dataFlows.push({
            from: server.id,
            to: core.id,
            through,
            description: `Server → core logic`,
          });
        }
      }
    }
  }

  private hasPath(source: string, target: string): boolean {
    const visited = new Set<string>();
    const queue = [source];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current === target) return true;
      if (visited.has(current)) continue;
      visited.add(current);
      const neighbors = this.adjacencyList.get(current) || [];
      for (const neighbor of neighbors) {
        if (!visited.has(neighbor)) {
          queue.push(neighbor);
        }
      }
    }
    return false;
  }

  private findShortestPath(source: string, target: string): string[] {
    const visited = new Set<string>();
    const parent = new Map<string, string | null>();
    const queue: string[] = [source];
    parent.set(source, null);

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current === target) break;
      if (visited.has(current)) continue;
      visited.add(current);

      const neighbors = this.adjacencyList.get(current) || [];
      for (const neighbor of neighbors) {
        if (!visited.has(neighbor) && !parent.has(neighbor)) {
          parent.set(neighbor, current);
          queue.push(neighbor);
        }
      }
    }

    const path: string[] = [];
    let current: string | null = target;
    while (current && parent.has(current)) {
      path.unshift(current);
      current = parent.get(current) || null;
    }

    return path;
  }

  private getCrossModuleEdges(): GraphEdge[] {
    return this.edges.filter(edge => {
      const sourceNode = this.nodeById.get(edge.source);
      const targetNode = this.nodeById.get(edge.target);
      return sourceNode && targetNode && sourceNode.moduleTag !== targetNode.moduleTag;
    });
  }

  private renderHierarchy(
    node: ModuleHierarchy,
    prefix: string,
    isLast: boolean,
    lines: string[],
    depth: number,
    maxDepth: number
  ): void {
    if (depth > maxDepth) return;

    if (depth > 0) {
      const connector = isLast ? '└── ' : '├── ';
      const icon = node.type === 'root' ? '' : node.type === 'submodule' ? '📁' : '📄';
      let label = `${icon} ${node.name}`;
      if (node.files.length > 1 && !node.children.length) {
        label += ` (${node.files.length} files)`;
      }
      lines.push(`${prefix}${connector}${label}`);
    }

    if (node.type !== 'file') {
      const children = node.children;
      for (let i = 0; i < children.length; i++) {
        const child = children[i];
        const newPrefix = depth === 0 ? '' : prefix + (isLast ? '    ' : '│   ');
        this.renderHierarchy(child, newPrefix, i === children.length - 1, lines, depth + 1, maxDepth);
      }
    }
  }

  private shortenName(filePath: string): string {
    const parts = filePath.replace(/\\/g, '/').split('/');
    const srcIndex = parts.lastIndexOf('src');
    if (srcIndex >= 0 && srcIndex < parts.length - 1) {
      return parts.slice(srcIndex + 1).join('/');
    }
    if (parts.length <= 3) return parts.join('/');
    return parts.slice(-3).join('/');
  }
}
