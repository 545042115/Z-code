// Change Impact Analysis Layer
// Analyzes the impact scope of a user request on the codebase.
// Uses static analysis (SymbolIndex, DependencyGraph, RepoGraph) as primary source,
// with LLM only for summarization.

import { DiscoveryReport } from '../../discovery/discovery';
import { TaskType, TaskUnderstandingResult } from '../task-understanding/task-understanding';
import { ArchitectureReviewReport } from '../architecture-review/architecture-review';
import { SymbolIndex, SymbolEntry } from '../../context/symbol-index';
import { DependencyGraph } from '../../context/dependency-graph';
import { RepoGraph } from '../../context/repo-graph';

export interface ChangeImpactSymbol {
  name: string;
  kind: string;
  filePath: string;
  line: number;
  containerName?: string;
  impactType: 'direct' | 'indirect' | 'reference';
  reason: string;
}

export interface ChangeImpactFile {
  path: string;
  impactType: 'direct' | 'indirect' | 'test' | 'config';
  reason: string;
  symbolCount: number;
  hasTests: boolean;
}

export interface ChangeImpactReport {
  affectedFiles: string[];
  affectedSymbols: string[];
  directImpactFiles: ChangeImpactFile[];
  indirectImpactFiles: ChangeImpactFile[];
  testImpactFiles: ChangeImpactFile[];
  entryPointRisk: boolean;
  testCoverageGap: string[];
  riskSummary: string;
  confidence: number;
}

export interface ChangePlanInput {
  userRequest: string;
  taskType: TaskType;
  taskUnderstanding: TaskUnderstandingResult;
  architectureReview: ArchitectureReviewReport;
  discoveryReport: DiscoveryReport;
}

/**
 * ChangeImpactAnalysis performs static analysis to determine the scope of a code change.
 *
 * Pipeline:
 * 1. Extract target files/symbols from task understanding + discovery
 * 2. Use SymbolIndex to find related symbols
 * 3. Use DependencyGraph to find upstream/downstream dependents
 * 4. Use RepoGraph to find module-level relationships
 * 5. Merge with DiscoveryReport impact surface
 * 6. Generate structured impact report + risk summary
 */
export class ChangeImpactAnalysis {
  constructor(
    private readonly symbolIndex: SymbolIndex,
    private readonly dependencyGraph: DependencyGraph,
    private readonly repoGraph: RepoGraph
  ) {}

  /**
   * Main entry point.
   */
  analyze(input: ChangePlanInput): ChangeImpactReport {
    const { userRequest, taskType, taskUnderstanding, architectureReview, discoveryReport } = input;

    // 1. Seed files from task understanding and discovery
    const seedFiles = this.extractSeedFiles(taskUnderstanding, discoveryReport);
    const seedSymbols = this.extractSeedSymbols(userRequest, taskUnderstanding, discoveryReport);

    // 2. Static analysis: expand impact via DependencyGraph + SymbolIndex
    const directFiles = this.analyzeDirectImpact(seedFiles, seedSymbols, discoveryReport);
    const indirectFiles = this.analyzeIndirectImpact(directFiles, discoveryReport);
    const testFiles = this.analyzeTestImpact(directFiles, indirectFiles, discoveryReport);

    // 3. Detect entry point risk
    const entryPointRisk = this.detectEntryPointRisk(directFiles, indirectFiles, discoveryReport);

    // 4. Detect test coverage gaps
    const testCoverageGap = this.detectTestCoverageGap(directFiles, indirectFiles, discoveryReport);

    // 5. Collect all affected symbols
    const affectedSymbols = this.collectAffectedSymbols(directFiles, indirectFiles, seedSymbols);

    // 6. Compute confidence based on data quality
    const confidence = this.computeConfidence(directFiles, indirectFiles, discoveryReport);

    // 7. Generate risk summary (LLM-free, rule-based)
    const riskSummary = this.generateRiskSummary(
      taskType,
      architectureReview,
      directFiles,
      indirectFiles,
      entryPointRisk,
      testCoverageGap,
      confidence
    );

    return {
      affectedFiles: [...new Set([
        ...directFiles.map(f => f.path),
        ...indirectFiles.map(f => f.path),
        ...testFiles.map(f => f.path),
      ])],
      affectedSymbols: [...new Set(affectedSymbols.map(s => s.name))],
      directImpactFiles: directFiles,
      indirectImpactFiles: indirectFiles,
      testImpactFiles: testFiles,
      entryPointRisk,
      testCoverageGap,
      riskSummary,
      confidence,
    };
  }

  /**
   * Formats the impact report into a concise prompt fragment for the Planner.
   */
  formatForPrompt(report: ChangeImpactReport): string {
    const parts: string[] = [];
    parts.push('## Change Impact Analysis');
    parts.push(`Confidence: ${Math.round(report.confidence * 100)}%`);
    parts.push(`Entry Point Risk: ${report.entryPointRisk ? 'YES' : 'No'}`);
    parts.push('');

    if (report.directImpactFiles.length > 0) {
      parts.push(`Direct Impact (${report.directImpactFiles.length} files):`);
      for (const f of report.directImpactFiles.slice(0, 8)) {
        parts.push(`  ${f.path} —${f.reason}`);
      }
      parts.push('');
    }

    if (report.indirectImpactFiles.length > 0) {
      parts.push(`Indirect Impact (${report.indirectImpactFiles.length} files):`);
      for (const f of report.indirectImpactFiles.slice(0, 5)) {
        parts.push(`  ${f.path} —${f.reason}`);
      }
      parts.push('');
    }

    if (report.testImpactFiles.length > 0) {
      parts.push(`Test Impact (${report.testImpactFiles.length} files):`);
      for (const f of report.testImpactFiles.slice(0, 5)) {
        parts.push(`  ${f.path} —${f.reason}`);
      }
      parts.push('');
    }

    if (report.affectedSymbols.length > 0) {
      parts.push(`Key Affected Symbols (${Math.min(report.affectedSymbols.length, 10)}):`);
      parts.push(`  ${report.affectedSymbols.slice(0, 10).join(', ')}`);
      parts.push('');
    }

    if (report.testCoverageGap.length > 0) {
      parts.push(`Test Coverage Gap: ${report.testCoverageGap.length} untested files`);
      for (const f of report.testCoverageGap.slice(0, 5)) {
        parts.push(`  ${f}`);
      }
      parts.push('');
    }

    parts.push('Risk Summary:');
    parts.push(report.riskSummary);

    return parts.join('\n');
  }

  // ── Internal Analysis Steps ──────────────────────────────────────────────

  private extractSeedFiles(
    taskUnderstanding: TaskUnderstandingResult,
    discoveryReport: DiscoveryReport
  ): string[] {
    const seeds: string[] = [];

    if (taskUnderstanding.primaryTarget) {
      seeds.push(taskUnderstanding.primaryTarget);
    }
    seeds.push(...taskUnderstanding.secondaryTargets);

    // Enrich with discovery report involved files
    for (const f of discoveryReport.involvedFiles) {
      if (!seeds.includes(f.path)) {
        seeds.push(f.path);
      }
    }

    return seeds;
  }

  private extractSeedSymbols(
    userRequest: string,
    taskUnderstanding: TaskUnderstandingResult,
    discoveryReport: DiscoveryReport
  ): ChangeImpactSymbol[] {
    const seeds: ChangeImpactSymbol[] = [];

    // Search SymbolIndex for symbols matching the request
    const query = taskUnderstanding.primaryTarget
      ? taskUnderstanding.primaryTarget.replace(/\.[^.]+$/, '')
      : userRequest;

    const symbolMatches = this.symbolIndex.search(query, 20);
    for (const sym of symbolMatches) {
      seeds.push({
        name: sym.name,
        kind: sym.kind,
        filePath: sym.filePath,
        line: sym.line,
        containerName: sym.containerName,
        impactType: 'direct',
        reason: 'matched by symbol name search',
      });
    }

    // Add symbols from discovery report
    for (const rs of discoveryReport.relatedSymbols) {
      if (!seeds.some(s => s.name === rs.name && s.filePath === rs.filePath)) {
        seeds.push({
          name: rs.name,
          kind: rs.kind,
          filePath: rs.filePath,
          line: rs.line,
          containerName: undefined,
          impactType: 'direct',
          reason: 'from discovery related symbols',
        });
      }
    }

    return seeds;
  }

  private analyzeDirectImpact(
    seedFiles: string[],
    seedSymbols: ChangeImpactSymbol[],
    discoveryReport: DiscoveryReport
  ): ChangeImpactFile[] {
    const files = new Map<string, ChangeImpactFile>();

    // From seed files
    for (const path of seedFiles) {
      const symbols = this.symbolIndex.getSymbolsInFile(path);
      files.set(path, {
        path,
        impactType: 'direct',
        reason: 'explicitly mentioned or discovered as target',
        symbolCount: symbols.length,
        hasTests: this.hasTestsForFile(path, discoveryReport),
      });
    }

    // From seed symbols
    for (const sym of seedSymbols) {
      if (!files.has(sym.filePath)) {
        const symbols = this.symbolIndex.getSymbolsInFile(sym.filePath);
        files.set(sym.filePath, {
          path: sym.filePath,
          impactType: 'direct',
          reason: `contains affected symbol "${sym.name}"`,
          symbolCount: symbols.length,
          hasTests: this.hasTestsForFile(sym.filePath, discoveryReport),
        });
      }
    }

    return Array.from(files.values());
  }

  private analyzeIndirectImpact(
    directFiles: ChangeImpactFile[],
    discoveryReport: DiscoveryReport
  ): ChangeImpactFile[] {
    const files = new Map<string, ChangeImpactFile>();

    for (const direct of directFiles) {
      // Upstream dependents (files that import this file)
      const dependents = this.dependencyGraph.getDependents(direct.path);
      for (const dep of dependents) {
        if (files.has(dep) || directFiles.some(d => d.path === dep)) continue;
        const symbols = this.symbolIndex.getSymbolsInFile(dep);
        files.set(dep, {
          path: dep,
          impactType: 'indirect',
          reason: `depends on ${this.basename(direct.path)}`,
          symbolCount: symbols.length,
          hasTests: this.hasTestsForFile(dep, discoveryReport),
        });
      }

      // Downstream dependencies (files this file imports)
      const dependencies = this.dependencyGraph.getDependencies(direct.path);
      for (const dep of dependencies) {
        if (files.has(dep) || directFiles.some(d => d.path === dep)) continue;
        const symbols = this.symbolIndex.getSymbolsInFile(dep);
        files.set(dep, {
          path: dep,
          impactType: 'indirect',
          reason: `imported by ${this.basename(direct.path)}`,
          symbolCount: symbols.length,
          hasTests: this.hasTestsForFile(dep, discoveryReport),
        });
      }
    }

    return Array.from(files.values());
  }

  private analyzeTestImpact(
    directFiles: ChangeImpactFile[],
    indirectFiles: ChangeImpactFile[],
    discoveryReport: DiscoveryReport
  ): ChangeImpactFile[] {
    const files = new Map<string, ChangeImpactFile>();
    const allImpacted = [...directFiles, ...indirectFiles];

    for (const impacted of allImpacted) {
      const testDeps = this.dependencyGraph.getDependents(impacted.path)
        .filter((dep: any) => /\.(test|spec)\./i.test(dep) || /test|spec/i.test(dep));

      for (const testFile of testDeps) {
        if (files.has(testFile)) continue;
        const symbols = this.symbolIndex.getSymbolsInFile(testFile);
        files.set(testFile, {
          path: testFile,
          impactType: 'test',
          reason: `tests affected file ${this.basename(impacted.path)}`,
          symbolCount: symbols.length,
          hasTests: true,
        });
      }
    }

    // Also include test files from discovery report
    for (const tc of discoveryReport.riskAnalysis.testCoverage) {
      if (tc.hasTests && !files.has(tc.file)) {
        const isRelated = allImpacted.some(f => f.path === tc.file);
        if (isRelated) {
          const symbols = this.symbolIndex.getSymbolsInFile(tc.file);
          files.set(tc.file, {
            path: tc.file,
            impactType: 'test',
            reason: 'test file for impacted code',
            symbolCount: symbols.length,
            hasTests: true,
          });
        }
      }
    }

    return Array.from(files.values());
  }

  private detectEntryPointRisk(
    directFiles: ChangeImpactFile[],
    indirectFiles: ChangeImpactFile[],
    discoveryReport: DiscoveryReport
  ): boolean {
    const allPaths = new Set([
      ...directFiles.map(f => f.path),
      ...indirectFiles.map(f => f.path),
    ]);

    const entryPoints = discoveryReport.repoKnowledge?.entryPoints || [];
    for (const ep of entryPoints) {
      if (allPaths.has(ep.path)) return true;
    }

    // Also check if any direct file is a high-dependency node
    for (const f of directFiles) {
      const dependents = this.dependencyGraph.getDependents(f.path);
      if (dependents.length > 20) return true;
    }

    return false;
  }

  private detectTestCoverageGap(
    directFiles: ChangeImpactFile[],
    indirectFiles: ChangeImpactFile[],
    discoveryReport: DiscoveryReport
  ): string[] {
    const gaps: string[] = [];
    const allImpacted = [...directFiles, ...indirectFiles];

    for (const f of allImpacted) {
      if (!f.hasTests) {
        gaps.push(f.path);
      }
    }

    // Also check discovery report test coverage
    for (const tc of discoveryReport.riskAnalysis.testCoverage) {
      if (!tc.hasTests && !gaps.includes(tc.file)) {
        const isImpacted = allImpacted.some(f => f.path === tc.file);
        if (isImpacted) {
          gaps.push(tc.file);
        }
      }
    }

    return gaps;
  }

  private collectAffectedSymbols(
    directFiles: ChangeImpactFile[],
    indirectFiles: ChangeImpactFile[],
    seedSymbols: ChangeImpactSymbol[]
  ): ChangeImpactSymbol[] {
    const allPaths = new Set([
      ...directFiles.map(f => f.path),
      ...indirectFiles.map(f => f.path),
    ]);

    const symbols: ChangeImpactSymbol[] = [...seedSymbols];
    const seen = new Set(symbols.map(s => `${s.filePath}#${s.name}`));

    for (const path of allPaths) {
      const fileSymbols = this.symbolIndex.getSymbolsInFile(path);
      for (const sym of fileSymbols) {
        const key = `${sym.filePath}#${sym.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        symbols.push({
          name: sym.name,
          kind: sym.kind,
          filePath: sym.filePath,
          line: sym.line,
          containerName: sym.containerName,
          impactType: allPaths.has(path) && !seedSymbols.some(s => s.filePath === path)
            ? 'indirect'
            : 'reference',
          reason: `symbol in impacted file ${this.basename(path)}`,
        });
      }
    }

    return symbols;
  }

  private computeConfidence(
    directFiles: ChangeImpactFile[],
    indirectFiles: ChangeImpactFile[],
    discoveryReport: DiscoveryReport
  ): number {
    let score = 0.7;

    // Higher confidence if we have discovery data
    if (discoveryReport.involvedFiles.length > 0) score += 0.1;
    if (discoveryReport.relatedSymbols.length > 0) score += 0.05;

    // Higher confidence if symbol index is built
    if (this.symbolIndex.isBuilt()) score += 0.1;

    // Penalty for very wide impact (uncertainty increases)
    const totalImpact = directFiles.length + indirectFiles.length;
    if (totalImpact > 30) score -= 0.15;
    else if (totalImpact > 15) score -= 0.05;

    return Math.max(0.3, Math.min(0.95, score));
  }

  private generateRiskSummary(
    taskType: TaskType,
    architectureReview: ArchitectureReviewReport,
    directFiles: ChangeImpactFile[],
    indirectFiles: ChangeImpactFile[],
    entryPointRisk: boolean,
    testCoverageGap: string[],
    confidence: number
  ): string {
    const parts: string[] = [];

    parts.push(`Task type "${taskType}" impacts ${directFiles.length} direct and ${indirectFiles.length} indirect files.`);

    if (entryPointRisk) {
      parts.push('WARNING: changes touch entry point files; risk of system-wide breakage.');
    }

    if (architectureReview.shouldUpdateReferences) {
      parts.push('Cross-file reference updates are required.');
    }

    if (architectureReview.violatesSingleResponsibility) {
      parts.push('Target code violates SRP; modification may have unexpected side effects.');
    }

    if (testCoverageGap.length > 0) {
      parts.push(`Test coverage gap: ${testCoverageGap.length} impacted files lack tests.`);
    }

    if (directFiles.length === 0) {
      parts.push('No direct impact files identified; confidence is low.');
    }

    parts.push(`Overall confidence: ${Math.round(confidence * 100)}%.`);

    return parts.join(' ');
  }

  private hasTestsForFile(filePath: string, discoveryReport: DiscoveryReport): boolean {
    const tc = discoveryReport.riskAnalysis.testCoverage.find((t: any) => t.file === filePath);
    return tc ? tc.hasTests : false;
  }

  private basename(path: string): string {
    return path.replace(/\\/g, '/').split('/').pop() || path;
  }
}
