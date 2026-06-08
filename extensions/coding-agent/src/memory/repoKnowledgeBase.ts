import * as vscode from 'vscode';
import * as path from 'path';
import { WorkspaceScanner, WorkspaceFile } from '../context/workspaceScanner';
import { RepoGraph, GraphNode } from '../context/repoGraph';
import { RepoMap } from '../context/repoMap';
import { DependencyGraph } from '../context/dependencyGraph';
import { SymbolIndex, SymbolEntry } from '../context/symbolIndex';

export interface RepoKnowledgeLayer {
  name: string;
  files: string[];
  fileCount: number;
  description: string;
}

export interface RepoKnowledgeArchitecture {
  summary: string;
  layers: RepoKnowledgeLayer[];
}

export interface RepoKnowledgeLanguage {
  name: string;
  percentage: number;
  extensions: string[];
  fileCount: number;
}

export interface RepoKnowledgeTechStack {
  languages: RepoKnowledgeLanguage[];
  frameworks: string[];
  buildTools: string[];
  testFrameworks: string[];
  packageManager: string;
}

export interface RepoKnowledgeEntryPoint {
  path: string;
  type: string;
  description: string;
}

export interface RepoKnowledgeCoreModule {
  name: string;
  fileCount: number;
  representativeFiles: string[];
  topExports: string[];
  description: string;
}

export interface RepoKnowledgeCodingPatterns {
  namingConventions: string[];
  fileOrganization: string;
  commonImports: Array<{ module: string; count: number }>;
  designPatterns: string[];
}

export interface RepoKnowledgeCriticalFile {
  path: string;
  dependentCount: number;
  reason: string;
}

export interface RepoKnowledge {
  version: string;
  generatedAt: number;
  updatedAt: number;
  architecture: RepoKnowledgeArchitecture;
  techStack: RepoKnowledgeTechStack;
  entryPoints: RepoKnowledgeEntryPoint[];
  coreModules: RepoKnowledgeCoreModule[];
  codingPatterns: RepoKnowledgeCodingPatterns;
  criticalFiles: RepoKnowledgeCriticalFile[];
  fileFingerprints: Record<string, { mtime: number; size: number }>;
}

export class RepoKnowledgeBase {
  private knowledge: RepoKnowledge | null = null;
  private readonly storageDir: string;
  private readonly storagePath: string;
  private updateTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingUpdates: Set<string> = new Set();

  constructor(
    private readonly scanner: WorkspaceScanner,
    private readonly repoGraph: RepoGraph,
    private readonly repoMap: RepoMap,
    private readonly dependencyGraph: DependencyGraph,
    private readonly symbolIndex: SymbolIndex
  ) {
    const workspaceRoot = this.scanner.getPrimaryWorkspaceRoot();
    this.storageDir = path.join(workspaceRoot, '.workspace', '.coding-agent');
    this.storagePath = path.join(this.storageDir, 'repo-knowledge.json');
  }

  get isReady(): boolean {
    return this.knowledge !== null;
  }

  getKnowledge(): RepoKnowledge | null {
    return this.knowledge;
  }

  // ── 生命周期 ───────────────────────────────────────────────────────────

  async init(): Promise<void> {
    if (await this.exists()) {
      await this.load();
      if (await this.isStale()) {
        await this.build();
      }
    } else {
      await this.build();
    }
  }

  async build(): Promise<void> {
    const sourceFiles = this.scanner.getSourceFiles();
    if (sourceFiles.length === 0) {
      return;
    }

    const now = Date.now();
    const architecture = this.buildArchitecture(sourceFiles);
    const techStack = this.buildTechStack(sourceFiles);
    const entryPoints = this.buildEntryPoints();
    const coreModules = this.buildCoreModules(sourceFiles);
    const codingPatterns = this.buildCodingPatterns(sourceFiles);
    const criticalFiles = this.buildCriticalFiles();
    const fingerprints = this.buildFingerprints(sourceFiles);

    this.knowledge = {
      version: '1.0',
      generatedAt: this.knowledge?.generatedAt || now,
      updatedAt: now,
      architecture,
      techStack,
      entryPoints,
      coreModules,
      codingPatterns,
      criticalFiles,
      fileFingerprints: fingerprints,
    };

    await this.save();
  }

  // ── 增量更新 ───────────────────────────────────────────────────────────

  scheduleIncrementalUpdate(changedFile: string): void {
    this.pendingUpdates.add(changedFile);

    if (this.updateTimer) {
      clearTimeout(this.updateTimer);
    }

    this.updateTimer = setTimeout(() => {
      this.applyIncrementalUpdate();
    }, 500);
  }

  private async applyIncrementalUpdate(): Promise<void> {
    const files = Array.from(this.pendingUpdates);
    this.pendingUpdates.clear();

    // 若变化量大或涉及配置文件，触发全量重建
    if (files.length > 5 || files.some(f => /package\.json|tsconfig|\.config\./i.test(f))) {
      await this.build();
      return;
    }

    if (!this.knowledge) {
      return;
    }

    // 增量更新指纹
    for (const file of files) {
      try {
        const uri = vscode.Uri.file(file);
        const stat = await vscode.workspace.fs.stat(uri);
        this.knowledge.fileFingerprints[file] = {
          mtime: stat.mtime,
          size: stat.size,
        };
      } catch {
        delete this.knowledge.fileFingerprints[file];
      }
    }

    this.knowledge.updatedAt = Date.now();
    await this.save();
  }

  // ── 构建各维度 ─────────────────────────────────────────────────────────

  private buildArchitecture(sourceFiles: WorkspaceFile[]): RepoKnowledgeArchitecture {
    const layerMap = new Map<string, string[]>();

    for (const file of sourceFiles) {
      const tag = this.repoGraph.getNode(file.path)?.moduleTag || 'other';
      if (!layerMap.has(tag)) {
        layerMap.set(tag, []);
      }
      layerMap.get(tag)!.push(file.path);
    }

    const layers: RepoKnowledgeLayer[] = [];
    for (const [tag, files] of layerMap) {
      layers.push({
        name: tag,
        files: files.slice(0, 20),
        fileCount: files.length,
        description: this.inferLayerDescription(tag),
      });
    }

    layers.sort((a, b) => b.fileCount - a.fileCount);

    return {
      summary: this.inferArchitectureSummary(layers),
      layers,
    };
  }

  private buildTechStack(sourceFiles: WorkspaceFile[]): RepoKnowledgeTechStack {
    const extCount = new Map<string, number>();
    for (const f of sourceFiles) {
      extCount.set(f.extension, (extCount.get(f.extension) || 0) + 1);
    }

    const total = sourceFiles.length || 1;
    const languages = Array.from(extCount.entries())
      .map(([ext, count]) => ({
        name: this.extToLanguage(ext),
        percentage: Math.round((count / total) * 100),
        extensions: [ext],
        fileCount: count,
      }))
      .sort((a, b) => b.fileCount - a.fileCount);

    return {
      languages,
      frameworks: this.detectFrameworks(),
      buildTools: this.detectBuildTools(),
      testFrameworks: this.detectTestFrameworks(),
      packageManager: this.detectPackageManager(),
    };
  }

  private buildEntryPoints(): RepoKnowledgeEntryPoint[] {
    const nodes = this.dependencyGraph.getAllNodes();
    const result: RepoKnowledgeEntryPoint[] = [];

    for (const node of nodes) {
      if (node.isEntryPoint) {
        const type = this.inferEntryPointType(node.filePath);
        result.push({
          path: node.filePath,
          type,
          description: `${type} 入口点`,
        });
      }
    }

    return result.slice(0, 10);
  }

  private buildCoreModules(sourceFiles: WorkspaceFile[]): RepoKnowledgeCoreModule[] {
    const dirMap = new Map<string, { files: string[]; symbols: SymbolEntry[] }>();

    for (const file of sourceFiles) {
      const normalized = file.path.replace(/\\/g, '/');
      const dir = normalized.split('/').slice(0, -1).join('/');
      if (!dirMap.has(dir)) {
        dirMap.set(dir, { files: [], symbols: [] });
      }
      dirMap.get(dir)!.files.push(file.path);
      const syms = this.symbolIndex.getSymbolsInFile(file.path);
      dirMap.get(dir)!.symbols.push(...syms);
    }

    const modules = Array.from(dirMap.entries())
      .map(([dir, data]) => {
        const exports = data.symbols
          .filter(
            (s) =>
              s.containerName === '' &&
              ['class', 'interface', 'function', 'enum'].includes(s.kind)
          )
          .slice(0, 10)
          .map((s) => s.name);

        return {
          name: dir.split('/').pop() || dir,
          fileCount: data.files.length,
          representativeFiles: data.files.slice(0, 5),
          topExports: exports,
          description: `${data.files.length} 个文件，${data.symbols.length} 个符号`,
        };
      })
      .sort((a, b) => b.fileCount - a.fileCount)
      .slice(0, 20);

    return modules;
  }

  private buildCodingPatterns(sourceFiles: WorkspaceFile[]): RepoKnowledgeCodingPatterns {
    const importMap = new Map<string, number>();
    const namingChecks = { pascalCase: 0, camelCase: 0, snakeCase: 0 };

    for (const file of sourceFiles) {
      const symbols = this.symbolIndex.getSymbolsInFile(file.path);
      for (const sym of symbols) {
        if (/^[A-Z]/.test(sym.name)) namingChecks.pascalCase++;
        else if (/^[a-z][a-zA-Z0-9]*$/.test(sym.name)) namingChecks.camelCase++;
        else if (/^[a-z][a-z0-9_]*$/.test(sym.name)) namingChecks.snakeCase++;
      }

      const node = this.dependencyGraph.getNode(file.path);
      if (node) {
        for (const dep of node.dependencies) {
          const pkg = this.extractPackageName(dep);
          importMap.set(pkg, (importMap.get(pkg) || 0) + 1);
        }
      }
    }

    const conventions: string[] = [];
    if (namingChecks.pascalCase > namingChecks.camelCase) {
      conventions.push('类/接口使用 PascalCase');
    }
    if (namingChecks.camelCase > 0) {
      conventions.push('函数/变量使用 camelCase');
    }

    const commonImports = Array.from(importMap.entries())
      .map(([module, count]) => ({ module, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    return {
      namingConventions: conventions,
      fileOrganization: '按目录/功能分层组织',
      commonImports,
      designPatterns: [],
    };
  }

  private buildCriticalFiles(): RepoKnowledgeCriticalFile[] {
    const critical = this.dependencyGraph.getCriticalFiles(10);
    return critical.map((c) => ({
      path: c.filePath,
      dependentCount: c.dependentCount,
      reason: `被 ${c.dependentCount} 个文件依赖`,
    }));
  }

  private buildFingerprints(sourceFiles: WorkspaceFile[]): Record<string, { mtime: number; size: number }> {
    const fingerprints: Record<string, { mtime: number; size: number }> = {};
    for (const file of sourceFiles) {
      fingerprints[file.path] = {
        mtime: file.lastModified,
        size: file.size,
      };
    }
    return fingerprints;
  }

  // ── 推断工具 ───────────────────────────────────────────────────────────

  private inferLayerDescription(tag: string): string {
    const map: Record<string, string> = {
      server: '服务端 API 路由与控制器层',
      core: '核心业务逻辑与通用工具层',
      ui: '用户界面组件与页面层',
      config: '配置文件与环境变量层',
      build: '构建脚本与工具链层',
      other: '其他支持文件',
    };
    return map[tag] || `${tag} 模块`;
  }

  private inferArchitectureSummary(layers: RepoKnowledgeLayer[]): string {
    const parts: string[] = [];
    const totalFiles = layers.reduce((sum, l) => sum + l.fileCount, 0);
    parts.push(`${totalFiles} 个源码文件`);

    const topLayers = layers.slice(0, 3);
    for (const layer of topLayers) {
      parts.push(`${layer.name}(${layer.fileCount})`);
    }

    return parts.join('，');
  }

  private inferEntryPointType(filePath: string): string {
    const lower = filePath.toLowerCase();
    if (/test|spec/.test(lower)) return 'test';
    if (/cli|bin|cmd/.test(lower)) return 'cli';
    if (/server|app|index/.test(lower)) return 'server';
    if (/main\.ts|main\.js/.test(lower)) return 'app';
    return 'lib';
  }

  private extToLanguage(ext: string): string {
    const map: Record<string, string> = {
      '.ts': 'TypeScript',
      '.tsx': 'TypeScript React',
      '.js': 'JavaScript',
      '.jsx': 'JavaScript React',
      '.py': 'Python',
      '.go': 'Go',
      '.rs': 'Rust',
      '.java': 'Java',
      '.cpp': 'C++',
      '.c': 'C',
      '.cs': 'C#',
      '.swift': 'Swift',
      '.kt': 'Kotlin',
      '.vue': 'Vue',
      '.svelte': 'Svelte',
    };
    return map[ext] || ext.replace('.', '').toUpperCase();
  }

  private detectFrameworks(): string[] {
    const frameworks: string[] = [];
    const files = this.scanner.getSourceFiles();
    const allPaths = files.map((f) => f.path.toLowerCase());
    const allText = allPaths.join(' ');

    if (/react|jsx|tsx/.test(allText)) frameworks.push('React');
    if (/vue/.test(allText)) frameworks.push('Vue');
    if (/express|koa|fastify|nest/.test(allText)) frameworks.push('Express/Nest');
    if (/next\.config|\.next\//.test(allText)) frameworks.push('Next.js');
    if (/angular/.test(allText)) frameworks.push('Angular');

    return frameworks;
  }

  private detectBuildTools(): string[] {
    const files = this.scanner.getFiles();
    const names = files.map((f) => f.path.split(/[/\\]/).pop()?.toLowerCase() || '');
    const tools: string[] = [];

    if (names.includes('vite.config.ts') || names.includes('vite.config.js')) tools.push('Vite');
    if (names.includes('webpack.config.js') || names.includes('webpack.config.ts')) tools.push('Webpack');
    if (names.includes('rollup.config.js')) tools.push('Rollup');
    if (names.includes('esbuild')) tools.push('ESBuild');
    if (names.includes('tsconfig.json')) tools.push('tsc');

    return tools;
  }

  private detectTestFrameworks(): string[] {
    const files = this.scanner.getFiles();
    const names = files.map((f) => f.path.split(/[/\\]/).pop()?.toLowerCase() || '');
    const frameworks: string[] = [];

    if (names.some((n) => n.includes('jest.config'))) frameworks.push('Jest');
    if (names.some((n) => n.includes('vitest.config'))) frameworks.push('Vitest');
    if (names.some((n) => n.includes('mocha'))) frameworks.push('Mocha');
    if (names.some((n) => n.includes('playwright.config'))) frameworks.push('Playwright');

    return frameworks;
  }

  private detectPackageManager(): string {
    const files = this.scanner.getFiles();
    const names = files.map((f) => f.path.split(/[/\\]/).pop()?.toLowerCase() || '');

    if (names.includes('pnpm-lock.yaml')) return 'pnpm';
    if (names.includes('yarn.lock')) return 'yarn';
    if (names.includes('package-lock.json')) return 'npm';
    return 'unknown';
  }

  private extractPackageName(depPath: string): string {
    const normalized = depPath.replace(/\\/g, '/');
    if (normalized.includes('node_modules')) {
      const parts = normalized.split('node_modules/');
      const last = parts[parts.length - 1];
      const segments = last.split('/');
      if (segments[0].startsWith('@')) {
        return `${segments[0]}/${segments[1]}`;
      }
      return segments[0];
    }
    return depPath.split('/').slice(-2).join('/');
  }

  // ── 存储 ───────────────────────────────────────────────────────────────

  private async exists(): Promise<boolean> {
    try {
      await vscode.workspace.fs.stat(vscode.Uri.file(this.storagePath));
      return true;
    } catch {
      return false;
    }
  }

  private async load(): Promise<void> {
    try {
      const data = await vscode.workspace.fs.readFile(vscode.Uri.file(this.storagePath));
      const json = new TextDecoder().decode(data);
      this.knowledge = JSON.parse(json);
    } catch {
      this.knowledge = null;
    }
  }

  private async save(): Promise<void> {
    if (!this.knowledge) return;

    try {
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(this.storageDir));
      const data = new TextEncoder().encode(JSON.stringify(this.knowledge, null, 2));
      await vscode.workspace.fs.writeFile(vscode.Uri.file(this.storagePath), data);
    } catch (err) {
      console.warn('[RepoKnowledgeBase] Save failed:', err);
    }
  }

  private async isStale(): Promise<boolean> {
    if (!this.knowledge) return true;

    const currentFiles = this.scanner.getSourceFiles();
    const fpCount = Object.keys(this.knowledge.fileFingerprints).length;

    if (Math.abs(currentFiles.length - fpCount) > fpCount * 0.1) {
      return true;
    }

    for (const file of currentFiles) {
      const fp = this.knowledge.fileFingerprints[file.path];
      if (!fp || fp.mtime !== file.lastModified || fp.size !== file.size) {
        return true;
      }
    }

    return false;
  }

  // ── 查询接口 ───────────────────────────────────────────────────────────

  getArchitecture(): RepoKnowledgeArchitecture | undefined {
    return this.knowledge?.architecture;
  }

  getTechStack(): RepoKnowledgeTechStack | undefined {
    return this.knowledge?.techStack;
  }

  getEntryPoints(): RepoKnowledgeEntryPoint[] {
    return this.knowledge?.entryPoints || [];
  }

  getCoreModules(): RepoKnowledgeCoreModule[] {
    return this.knowledge?.coreModules || [];
  }

  getCodingPatterns(): RepoKnowledgeCodingPatterns | undefined {
    return this.knowledge?.codingPatterns;
  }

  getCriticalFiles(): RepoKnowledgeCriticalFile[] {
    return this.knowledge?.criticalFiles || [];
  }

  getModuleForFile(filePath: string): string {
    return this.repoGraph.getNode(filePath)?.moduleTag || 'other';
  }

  isEntryPoint(filePath: string): boolean {
    const node = this.dependencyGraph.getNode(filePath);
    return node?.isEntryPoint || false;
  }

  formatForPrompt(maxChars: number = 2000): string {
    if (!this.knowledge) return '(repo knowledge not built)';

    const parts: string[] = ['## Repo Knowledge Base\n'];

    parts.push(this.formatArchitectureSummary());
    parts.push(this.formatTechStack());
    parts.push(this.formatEntryPoints());
    parts.push(this.formatCoreModules());

    const text = parts.join('\n');
    return text.length > maxChars ? text.slice(0, maxChars) + '\n...' : text;
  }

  formatArchitectureSummary(): string {
    const arch = this.knowledge?.architecture;
    if (!arch) return '';
    const lines = ['### Architecture', arch.summary];
    for (const layer of arch.layers.slice(0, 6)) {
      lines.push(`  ${layer.name}: ${layer.fileCount} files — ${layer.description}`);
    }
    return lines.join('\n');
  }

  formatTechStack(): string {
    const ts = this.knowledge?.techStack;
    if (!ts) return '';
    const lines = ['### Tech Stack'];
    const topLang = ts.languages.slice(0, 3).map((l) => `${l.name}(${l.percentage}%)`).join(', ');
    lines.push(`  Languages: ${topLang}`);
    if (ts.frameworks.length) lines.push(`  Frameworks: ${ts.frameworks.join(', ')}`);
    if (ts.buildTools.length) lines.push(`  Build: ${ts.buildTools.join(', ')}`);
    if (ts.testFrameworks.length) lines.push(`  Test: ${ts.testFrameworks.join(', ')}`);
    lines.push(`  Package Manager: ${ts.packageManager}`);
    return lines.join('\n');
  }

  formatEntryPoints(): string {
    const eps = this.knowledge?.entryPoints || [];
    if (eps.length === 0) return '';
    const lines = ['### Entry Points'];
    for (const ep of eps.slice(0, 5)) {
      lines.push(`  ${ep.path.split(/[/\\]/).pop()} (${ep.type})`);
    }
    return lines.join('\n');
  }

  formatCoreModules(): string {
    const mods = this.knowledge?.coreModules || [];
    if (mods.length === 0) return '';
    const lines = ['### Core Modules'];
    for (const mod of mods.slice(0, 8)) {
      const exports = mod.topExports.slice(0, 3).join(', ');
      lines.push(`  ${mod.name} — ${mod.fileCount} files${exports ? ` [${exports}]` : ''}`);
    }
    return lines.join('\n');
  }
}
