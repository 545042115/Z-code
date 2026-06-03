import { SymbolIndex, SymbolEntry } from './symbolIndex';
import { DependencyGraph } from './dependencyGraph';
import { RepoMap } from './repoMap';

export interface ImpactResult {
  targetFile: string;
  targetSymbols: SymbolEntry[];
  directDependents: { file: string; depth: number }[];
  transitiveDependents: { file: string; depth: number }[];
  totalAffectedFiles: number;
  criticalScore: 'low' | 'medium' | 'high' | 'critical';
  affectedEntryPoints: string[];
  affectedModules: string[];
  summary: string;
}

export interface BatchImpactResult {
  files: ImpactResult[];
  totalAffectedUnique: number;
  mostImpacted: string;
  summary: string;
}

export class ImpactAnalyzer {
  constructor(
    private readonly symbolIndex: SymbolIndex,
    private readonly dependencyGraph: DependencyGraph,
    private readonly repoMap: RepoMap
  ) {}

  analyze(filePath: string, maxDepth: number = 3): ImpactResult {
    const symbols = this.symbolIndex.getSymbolsInFile(filePath);
    const direct = this.dependencyGraph
      .getDependents(filePath)
      .map(f => ({ file: f, depth: 1 }));
    const transitive = this.dependencyGraph.getTransitiveDependents(filePath, maxDepth);

    const allAffected = new Set<string>();
    for (const d of direct) allAffected.add(d.file);
    for (const t of transitive) allAffected.add(t.file);

    const affectedFiles = Array.from(allAffected);
    const entryPoints = affectedFiles.filter(f => {
      const node = this.dependencyGraph.getNode(f);
      return node?.isEntryPoint;
    });

    const moduleSet = new Set<string>();
    for (const f of affectedFiles) {
      const dir = f.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
      moduleSet.add(dir);
    }

    const score = this.calculateScore(entryPoints.length, allAffected.size);

    const summary = [
      `Impact analysis for: ${this.shortenPath(filePath)}`,
      `  Symbols affected: ${symbols.length} (${symbols.slice(0, 5).map(s => s.name).join(', ')})`,
      `  Direct dependents: ${direct.length}`,
      `  Total transitive dependents: ${transitive.length}`,
      `  Total files potentially affected: ${allAffected.size}`,
      `  Entry points affected: ${entryPoints.length}`,
      `  Critical score: ${score}`,
    ].join('\n');

    return {
      targetFile: filePath,
      targetSymbols: symbols,
      directDependents: direct,
      transitiveDependents: transitive,
      totalAffectedFiles: allAffected.size,
      criticalScore: score,
      affectedEntryPoints: entryPoints.map(e => this.shortenPath(e)),
      affectedModules: Array.from(moduleSet).map(m => this.shortenPath(m)),
      summary,
    };
  }

  analyzeSymbol(symbolName: string): ImpactResult | null {
    const matches = this.symbolIndex.search(symbolName, 5);

    for (const sym of matches) {
      if (sym.name === symbolName || sym.name.toLowerCase() === symbolName.toLowerCase()) {
        return this.analyze(sym.filePath);
      }
    }

    return null;
  }

  analyzeBatch(filePaths: string[]): BatchImpactResult {
    const results = filePaths.map(f => this.analyze(f));
    const allAffected = new Set<string>();

    for (const r of results) {
      allAffected.add(r.targetFile);
      for (const d of r.directDependents) allAffected.add(d.file);
      for (const t of r.transitiveDependents) allAffected.add(t.file);
    }

    const sorted = [...results].sort((a, b) => b.totalAffectedFiles - a.totalAffectedFiles);

    return {
      files: results,
      totalAffectedUnique: allAffected.size,
      mostImpacted: sorted[0]?.targetFile || '',
      summary: [
        `Batch impact analysis: ${filePaths.length} files`,
        `  Total unique files affected: ${allAffected.size}`,
        `  Most impactful change: ${this.shortenPath(sorted[0]?.targetFile || '')} (${sorted[0]?.totalAffectedFiles || 0} files)`,
      ].join('\n'),
    };
  }

  getArchitectureRisks(): { file: string; risk: 'high' | 'medium' | 'low'; reason: string }[] {
    const risks: { file: string; risk: 'high' | 'medium' | 'low'; reason: string }[] = [];
    const critical = this.dependencyGraph.getCriticalFiles(20);

    for (const c of critical) {
      const node = this.dependencyGraph.getNode(c.filePath);
      if (!node) continue;

      const directDepCount = node.dependencies.length;
      const transitiveCount = this.dependencyGraph.getTransitiveDependents(c.filePath, 5).length;

      let risk: 'high' | 'medium' | 'low';
      let reason: string;

      if (c.dependentCount > 20) {
        risk = 'high';
        reason = `Hub file: ${c.dependentCount} direct dependents, ${transitiveCount} transitive`;
      } else if (c.dependentCount > 5) {
        risk = 'medium';
        reason = `Moderate dependency hub: ${c.dependentCount} dependents`;
      } else {
        risk = 'low';
        reason = `${c.dependentCount} dependents, manageable scope`;
      }

      if (directDepCount > 15) {
        risk = 'high';
        reason += '. Also has high fan-in';
      }

      risks.push({ file: c.filePath, risk, reason });
    }

    const islands = this.dependencyGraph.getIslands();
    const sortedIslands = islands.sort((a, b) => b.length - a.length);
    if (sortedIslands.length > 1) {
      const smallIslands = sortedIslands.slice(1);
      for (const island of smallIslands) {
        const entry = island.find(f => this.dependencyGraph.getNode(f)?.isEntryPoint);
        risks.push({
          file: entry || island[0],
          risk: 'medium',
          reason: `Isolated subgraph (${island.length} files) with no connections to main graph`,
        });
      }
    }

    return risks;
  }

  formatForPrompt(filePath: string): string {
    return this.analyze(filePath).summary;
  }

  private calculateScore(entryPointCount: number, totalAffected: number): 'low' | 'medium' | 'high' | 'critical' {
    if (totalAffected > 50 || entryPointCount > 3) return 'critical';
    if (totalAffected > 20 || entryPointCount > 1) return 'high';
    if (totalAffected > 5) return 'medium';
    return 'low';
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