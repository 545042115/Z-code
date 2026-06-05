import { EmbeddingManager, EmbeddingResult } from '../embedding/embeddingManager';
import { RepoGraph } from './repoGraph';
import { DependencyGraph } from './dependencyGraph';
import { SymbolIndex } from './symbolIndex';
import { Reranker, CandidateData, RetrievalIntent } from './reranker';

export interface HybridSearchOptions {
  topK?: number;
  bm25Weight?: number;
  embeddingWeight?: number;
  graphWeight?: number;
  codeRelevanceWeight?: number;
  fileTypeWeight?: number;
  searchTerms?: string[];
}

export interface HybridSearchResult extends EmbeddingResult {
  bm25Score: number;
  embeddingScore: number;
  graphScore: number;
  codeRelevanceScore: number;
  fileTypeScore: number;
}

export interface StageResult {
  filePath: string;
  score: number;
  summary?: string;
}

export interface RetrievalDebugResult {
  query: string;
  intent: RetrievalIntent;
  latencyMs: number;
  bm25Top: StageResult[];
  embeddingTop: StageResult[];
  hybridMergedTop: StageResult[];
  finalRerankedTop: HybridSearchResult[];
  filesAddedByGraph: string[];
  filesPromotedByRerank: Array<{ filePath: string; oldRank: number; newRank: number }>;
}

interface Bm25Doc {
  filePath: string;
  tokens: string[];
  length: number;
}

/**
 * Simple BM25 implementation using the same tokenization as EmbeddingManager.
 */
class SimpleBM25 {
  private docs: Bm25Doc[] = [];
  private df = new Map<string, number>();
  private avgdl = 0;
  private N = 0;

  constructor(documents: Array<{ filePath: string; tokens: string[] }>) {
    this.N = documents.length;
    let totalLen = 0;

    for (const doc of documents) {
      const len = doc.tokens.length;
      this.docs.push({ filePath: doc.filePath, tokens: doc.tokens, length: len });
      totalLen += len;

      const seen = new Set(doc.tokens);
      for (const token of seen) {
        this.df.set(token, (this.df.get(token) || 0) + 1);
      }
    }

    this.avgdl = totalLen / this.N || 1;
  }

  search(queryTokens: string[], k1 = 1.2, b = 0.75): Map<string, number> {
    const scores = new Map<string, number>();

    for (const doc of this.docs) {
      let hasMatch = false;
      for (const q of queryTokens) {
        if (doc.tokens.includes(q)) {
          hasMatch = true;
          break;
        }
      }
      if (!hasMatch) {
        continue;
      }

      const tfMap = new Map<string, number>();
      for (const t of doc.tokens) {
        tfMap.set(t, (tfMap.get(t) || 0) + 1);
      }

      let score = 0;
      for (const q of queryTokens) {
        const df = this.df.get(q) || 0;
        if (df === 0) {
          continue;
        }
        const idf = Math.log((this.N - df + 0.5) / (df + 0.5) + 1);
        const tf = tfMap.get(q) || 0;
        score += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (doc.length / this.avgdl))));
      }

      scores.set(doc.filePath, score);
    }

    return scores;
  }
}

export class HybridRetrieval {
  private bm25Index: SimpleBM25 | null = null;
  private reranker = new Reranker();
  private readonly DEFAULT_TOP_K = 10;

  private readonly CODE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java', '.cpp', '.c', '.h', '.cs']);
  private readonly DOC_EXTS = new Set(['.md', '.txt', '.rst', '.adoc', '.markdown']);
  private readonly MAX_GRAPH_EXPANSION = 5;

  constructor(
    private readonly embeddingManager: EmbeddingManager,
    private readonly repoGraph: RepoGraph,
    private readonly dependencyGraph: DependencyGraph,
    private readonly symbolIndex: SymbolIndex
  ) {}

  private ensureBM25(): SimpleBM25 | null {
    if (this.bm25Index) {
      return this.bm25Index;
    }
    if (!this.embeddingManager.isBuilt) {
      return null;
    }

    const docs = this.embeddingManager.getDocuments();
    if (docs.length === 0) {
      return null;
    }

    this.bm25Index = new SimpleBM25(docs);
    return this.bm25Index;
  }

  /** Detect retrieval intent for dynamic weighting. */
  private detectIntent(query: string): RetrievalIntent {
    const lower = query.toLowerCase();
    const bugKeywords = ['fix', 'bug', 'error', 'crash', 'broken', 'fails', 'issue', 'regression', 'patch', 'correct'];
    const modificationKeywords = ['add', 'implement', 'refactor', 'logging', 'debug', 'optimize', 'improve', 'change', 'update', 'remove', 'delete', 'modify', 'enhance', 'migrate', 'upgrade', 'downgrade'];
    const explanationKeywords = ['explain', 'architecture', 'overview', 'describe', 'what', 'how', 'why', 'structure', 'design', 'document', 'understand', 'learn', 'clarify', 'summarize'];

    const hasBug = bugKeywords.some(kw => lower.includes(kw));
    const hasModification = modificationKeywords.some(kw => lower.includes(kw));
    const hasExplanation = explanationKeywords.some(kw => lower.includes(kw));

    if (hasBug && !hasExplanation) return 'bug_fix';
    if (hasModification && !hasExplanation) return 'modification';
    if (hasExplanation && !hasModification) return 'project_understanding';
    if (hasExplanation && hasModification) return 'explanation';
    return 'neutral';
  }

  /** Dynamic file type score: code files get high scores, docs get very low scores. */
  private getFileTypeScore(filePath: string): number {
    const ext = filePath.substring(filePath.lastIndexOf('.')).toLowerCase();
    switch (ext) {
      case '.ts':
      case '.tsx': return 1.0;
      case '.js':
      case '.jsx': return 0.9;
      case '.json': return 0.5;
      case '.md':
      case '.txt':
      case '.rst':
      case '.adoc':
      case '.markdown': return 0.1;
      default:
        if (this.CODE_EXTS.has(ext)) return 0.7;
        return 0.3;
    }
  }

  /** Score based on density of structural code symbols (functions, classes, etc.). */
  private getCodeRelevanceScore(filePath: string): number {
    const symbols = this.symbolIndex.getSymbolsInFile(filePath);
    if (!symbols || symbols.length === 0) return 0;

    let score = 0;
    for (const sym of symbols) {
      switch (sym.kind) {
        case 'function': score += 0.05; break;
        case 'class': score += 0.08; break;
        case 'method': score += 0.04; break;
        case 'interface': score += 0.06; break;
        case 'enum': score += 0.03; break;
        case 'constructor': score += 0.03; break;
        case 'struct': score += 0.05; break;
        case 'type_parameter': score += 0.02; break;
      }
    }
    return Math.min(score, 1.0);
  }

  /**
   * True graph expansion: inject direct dependencies, dependents, and same-module files
   * into the candidate pool.
   */
  private expandCandidatesWithGraph(
    candidates: Map<string, CandidateData>,
    topK: number
  ): string[] {
    const addedFiles: string[] = [];
    const topFiles = Array.from(candidates.keys()).slice(0, topK);

    for (const filePath of topFiles) {
      if (addedFiles.length >= this.MAX_GRAPH_EXPANSION) {
        break;
      }

      const depNode = this.dependencyGraph.getNode(filePath);
      if (depNode) {
        for (const dep of depNode.dependencies) {
          if (addedFiles.length >= this.MAX_GRAPH_EXPANSION) break;
          if (!candidates.has(dep)) {
            candidates.set(dep, {
              bm25Score: 0,
              embeddingScore: 0,
              graphScore: 0,
              fileTypeScore: this.getFileTypeScore(dep),
              codeRelevanceScore: this.getCodeRelevanceScore(dep),
              summary: '',
            });
            addedFiles.push(dep);
          }
        }
        for (const dep of depNode.dependents) {
          if (addedFiles.length >= this.MAX_GRAPH_EXPANSION) break;
          if (!candidates.has(dep)) {
            candidates.set(dep, {
              bm25Score: 0,
              embeddingScore: 0,
              graphScore: 0,
              fileTypeScore: this.getFileTypeScore(dep),
              codeRelevanceScore: this.getCodeRelevanceScore(dep),
              summary: '',
            });
            addedFiles.push(dep);
          }
        }
      }

      const repoNode = this.repoGraph.getNode(filePath);
      if (repoNode?.moduleTag) {
        const moduleNodes = this.repoGraph.getNodesByModule(repoNode.moduleTag);
        for (const node of moduleNodes) {
          if (addedFiles.length >= this.MAX_GRAPH_EXPANSION) break;
          if (!candidates.has(node.id)) {
            candidates.set(node.id, {
              bm25Score: 0,
              embeddingScore: 0,
              graphScore: 0,
              fileTypeScore: this.getFileTypeScore(node.id),
              codeRelevanceScore: this.getCodeRelevanceScore(node.id),
              summary: '',
            });
            addedFiles.push(node.id);
          }
        }
      }
    }

    return addedFiles;
  }

  /** Apply intent-based multipliers to code vs documentation files. */
  private applyIntentAdjustment(
    ranked: Array<Required<Pick<HybridSearchResult, 'filePath' | 'score'>> & Partial<HybridSearchResult>>,
    intent: RetrievalIntent
  ): Array<Required<Pick<HybridSearchResult, 'filePath' | 'score'>> & Partial<HybridSearchResult>> {
    if (intent === 'neutral') return ranked;

    return ranked
      .map(r => {
        const ext = r.filePath.substring(r.filePath.lastIndexOf('.')).toLowerCase();
        const isDoc = this.DOC_EXTS.has(ext);
        const isCode = this.CODE_EXTS.has(ext);
        let adjusted = r.score;

        if (intent === 'modification' || intent === 'bug_fix') {
          // Code-heavy tasks: boost code files, heavily penalize docs
          if (isCode) adjusted *= 1.3;
          if (isDoc) adjusted *= 0.2;
        } else if (intent === 'project_understanding' || intent === 'explanation') {
          // Understanding tasks: slight boost for docs, mild boost for code
          if (isDoc) adjusted *= 1.15;
          if (isCode) adjusted *= 1.05;
        }

        return { ...r, score: Math.round(adjusted * 1000) / 1000 };
      })
      .sort((a, b) => b.score - a.score);
  }

  async search(query: string, options: HybridSearchOptions = {}): Promise<HybridSearchResult[]> {
    const startTime = Date.now();
    const topK = options.topK ?? this.DEFAULT_TOP_K;
    const effectiveQuery = options.searchTerms && options.searchTerms.length > 0
      ? options.searchTerms.join(' ')
      : query;
    const intent = this.detectIntent(effectiveQuery);

    console.log(`[HybridRetrieval] Original query="${query.slice(0, 50)}"`);
    console.log(`[HybridRetrieval] searchTerms=${JSON.stringify(options.searchTerms)}`);
    console.log(`[HybridRetrieval] effectiveQuery="${effectiveQuery}"`);
    console.log(`[HybridRetrieval] Search started for: "${query.slice(0, 50)}" (intent: ${intent})`);
    if (options.searchTerms && options.searchTerms.length > 0) {
      console.log(`[HybridRetrieval] Using rewritten search terms: ${options.searchTerms.join(', ')}`);
    }

    // 1. Embedding search
    const embStart = Date.now();
    const embeddingResults = this.embeddingManager.search(effectiveQuery, topK * 2);
    console.log(`[HybridRetrieval] Embedding search: ${embeddingResults.length} results in ${Date.now() - embStart}ms`);

    // 2. BM25 search
    const bm25Start = Date.now();
    const bm25 = this.ensureBM25();
    const queryTokens = this.embeddingManager.tokenize(effectiveQuery);
    const bm25Scores = bm25 ? bm25.search(queryTokens) : new Map<string, number>();
    console.log(`[HybridRetrieval] BM25 search: ${bm25Scores.size} docs scored in ${Date.now() - bm25Start}ms`);

    // 3. Build initial candidates
    const candidates = new Map<string, CandidateData>();

    for (const r of embeddingResults) {
      candidates.set(r.filePath, {
        bm25Score: bm25Scores.get(r.filePath) || 0,
        embeddingScore: r.score,
        graphScore: 0,
        fileTypeScore: this.getFileTypeScore(r.filePath),
        codeRelevanceScore: this.getCodeRelevanceScore(r.filePath),
        summary: r.summary,
      });
    }

    const sortedBm25 = Array.from(bm25Scores.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, topK * 2);

    for (const [fp, score] of sortedBm25) {
      if (!candidates.has(fp)) {
        candidates.set(fp, {
          bm25Score: score,
          embeddingScore: 0,
          graphScore: 0,
          fileTypeScore: this.getFileTypeScore(fp),
          codeRelevanceScore: this.getCodeRelevanceScore(fp),
          summary: '',
        });
      }
    }

    // 4. True graph expansion
    const graphExpandStart = Date.now();
    const filesAddedByGraph = this.expandCandidatesWithGraph(candidates, topK);

    // Backfill BM25 scores for graph-added files (BM25 already scored entire corpus)
    for (const fp of filesAddedByGraph) {
      const c = candidates.get(fp);
      if (c) {
        c.bm25Score = bm25Scores.get(fp) || 0;
      }
    }
    console.log(`[HybridRetrieval] Graph expansion: +${filesAddedByGraph.length} files in ${Date.now() - graphExpandStart}ms`);

    // 5. Graph proximity scoring for all candidates
    const graphScoreStart = Date.now();
    const seedSet = new Set(Array.from(candidates.keys()).slice(0, topK));
    for (const [fp, scores] of candidates) {
      scores.graphScore = this.computeGraphProximity(fp, seedSet);
    }
    console.log(`[HybridRetrieval] Graph scoring: ${candidates.size} candidates in ${Date.now() - graphScoreStart}ms`);

    // 6. Normalize BM25 and embedding
    let maxBm25 = 0;
    let maxEmb = 0;
    for (const s of candidates.values()) {
      if ((s.bm25Score || 0) > maxBm25) maxBm25 = s.bm25Score!;
      if ((s.embeddingScore || 0) > maxEmb) maxEmb = s.embeddingScore!;
    }
    for (const s of candidates.values()) {
      s.bm25Score = maxBm25 > 0 ? (s.bm25Score || 0) / maxBm25 : 0;
      s.embeddingScore = maxEmb > 0 ? (s.embeddingScore || 0) / maxEmb : 0;
    }

    // 7. Rerank with extended formula
    const rerankStart = Date.now();
    const ranked = this.reranker.rerank(candidates, {
      intent,
      bm25Weight: options.bm25Weight,
      embeddingWeight: options.embeddingWeight,
      graphWeight: options.graphWeight,
      codeRelevanceWeight: options.codeRelevanceWeight,
      fileTypeWeight: options.fileTypeWeight,
    });
    console.log(`[HybridRetrieval] Reranking: ${ranked.length} docs in ${Date.now() - rerankStart}ms`);

    // 8. Intent-aware adjustment
    const intentStart = Date.now();
    const withIntent = this.applyIntentAdjustment(
      ranked.map(r => ({
        filePath: r.filePath,
        score: r.finalScore,
        bm25Score: r.bm25Score,
        embeddingScore: r.embeddingScore,
        graphScore: r.graphScore,
        codeRelevanceScore: r.codeRelevanceScore,
        fileTypeScore: r.fileTypeScore,
        summary: r.summary,
      })),
      intent
    );
    console.log(`[HybridRetrieval] Intent adjustment in ${Date.now() - intentStart}ms`);

    const results: HybridSearchResult[] = withIntent.slice(0, topK).map(r => ({
      filePath: r.filePath,
      score: r.score,
      summary: r.summary || '',
      bm25Score: r.bm25Score!,
      embeddingScore: r.embeddingScore!,
      graphScore: r.graphScore!,
      codeRelevanceScore: r.codeRelevanceScore!,
      fileTypeScore: r.fileTypeScore!,
    }));

    console.log(`[HybridRetrieval] Total time: ${Date.now() - startTime}ms, returning ${results.length} results`);
    return results;
  }

  /**
   * Compute graph proximity of a file to a set of seed files.
   * Boosts: direct imports / dependents (+1.0), same module (+0.5).
   * Normalized to [0, 1] by the size of the seed set.
   */
  private computeGraphProximity(filePath: string, seedSet: Set<string>): number {
    let score = 0;
    const depNode = this.dependencyGraph.getNode(filePath);
    const repoNode = this.repoGraph.getNode(filePath);
    const fileModule = repoNode?.moduleTag;

    for (const seed of seedSet) {
      if (seed === filePath) {
        continue;
      }

      if (depNode) {
        if (depNode.dependencies.includes(seed) || depNode.dependents.includes(seed)) {
          score += 1.0;
        }
      }

      const seedRepoNode = this.repoGraph.getNode(seed);
      if (fileModule && seedRepoNode?.moduleTag && fileModule === seedRepoNode.moduleTag) {
        score += 0.5;
      }
    }

    return Math.min(score / Math.max(seedSet.size, 1), 1.0);
  }

  /**
   * Debug search that exposes every pipeline stage for quality analysis.
   */
  async debugSearch(query: string, options: HybridSearchOptions = {}): Promise<RetrievalDebugResult> {
    const startTime = Date.now();
    const topK = options.topK ?? this.DEFAULT_TOP_K;
    const effectiveQuery = options.searchTerms && options.searchTerms.length > 0
      ? options.searchTerms.join(' ')
      : query;
    const intent = this.detectIntent(effectiveQuery);

    // Stage 1: BM25 only
    const bm25 = this.ensureBM25();
    const queryTokens = this.embeddingManager.tokenize(effectiveQuery);
    const bm25Scores = bm25 ? bm25.search(queryTokens) : new Map<string, number>();
    const bm25Top = Array.from(bm25Scores.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, topK)
      .map(([filePath, score]) => ({ filePath, score: Math.round(score * 1000) / 1000 }));

    // Stage 2: Embedding only
    const embeddingResults = this.embeddingManager.search(effectiveQuery, topK);
    const embeddingTop = embeddingResults.map(r => ({
      filePath: r.filePath,
      score: r.score,
      summary: r.summary,
    }));

    // Stage 3: Hybrid merged (BM25 + Embedding, before graph / rerank / intent)
    const candidates = new Map<string, CandidateData>();
    for (const r of embeddingResults) {
      candidates.set(r.filePath, {
        bm25Score: bm25Scores.get(r.filePath) || 0,
        embeddingScore: r.score,
        graphScore: 0,
        fileTypeScore: this.getFileTypeScore(r.filePath),
        codeRelevanceScore: this.getCodeRelevanceScore(r.filePath),
        summary: r.summary,
      });
    }
    const sortedBm25 = Array.from(bm25Scores.entries()).sort((a, b) => b[1] - a[1]).slice(0, topK * 2);
    for (const [fp, score] of sortedBm25) {
      if (!candidates.has(fp)) {
        candidates.set(fp, {
          bm25Score: score,
          embeddingScore: 0,
          graphScore: 0,
          fileTypeScore: this.getFileTypeScore(fp),
          codeRelevanceScore: this.getCodeRelevanceScore(fp),
          summary: '',
        });
      }
    }

    // Normalize for merged preview
    let maxBm25 = 0;
    let maxEmb = 0;
    for (const s of candidates.values()) {
      if ((s.bm25Score || 0) > maxBm25) maxBm25 = s.bm25Score!;
      if ((s.embeddingScore || 0) > maxEmb) maxEmb = s.embeddingScore!;
    }
    const mergedTop: StageResult[] = [];
    for (const [fp, s] of candidates) {
      const bm25Norm = maxBm25 > 0 ? (s.bm25Score || 0) / maxBm25 : 0;
      const embNorm = maxEmb > 0 ? (s.embeddingScore || 0) / maxEmb : 0;
      mergedTop.push({
        filePath: fp,
        score: Math.round((0.5 * bm25Norm + 0.5 * embNorm) * 1000) / 1000,
        summary: s.summary,
      });
    }
    mergedTop.sort((a, b) => b.score - a.score);
    const hybridMergedTop = mergedTop.slice(0, topK);

    // Stage 4: Graph expansion tracking
    const seedFiles = Array.from(candidates.keys()).slice(0, topK);
    const seedSet = new Set(seedFiles);
    const beforeGraphFiles = new Set(candidates.keys());

    const filesAddedByGraph = this.expandCandidatesWithGraph(candidates, topK);
    for (const fp of filesAddedByGraph) {
      const c = candidates.get(fp);
      if (c) {
        c.bm25Score = bm25Scores.get(fp) || 0;
      }
    }

    for (const [fp, scores] of candidates) {
      scores.graphScore = this.computeGraphProximity(fp, seedSet);
    }

    // Final normalization + rerank + intent
    maxBm25 = 0;
    maxEmb = 0;
    for (const s of candidates.values()) {
      if ((s.bm25Score || 0) > maxBm25) maxBm25 = s.bm25Score!;
      if ((s.embeddingScore || 0) > maxEmb) maxEmb = s.embeddingScore!;
    }
    for (const s of candidates.values()) {
      s.bm25Score = maxBm25 > 0 ? (s.bm25Score || 0) / maxBm25 : 0;
      s.embeddingScore = maxEmb > 0 ? (s.embeddingScore || 0) / maxEmb : 0;
    }

    const ranked = this.reranker.rerank(candidates, { intent });
    const withIntent = this.applyIntentAdjustment(
      ranked.map(r => ({
        filePath: r.filePath,
        score: r.finalScore,
        bm25Score: r.bm25Score,
        embeddingScore: r.embeddingScore,
        graphScore: r.graphScore,
        codeRelevanceScore: r.codeRelevanceScore,
        fileTypeScore: r.fileTypeScore,
        summary: r.summary,
      })),
      intent
    );

    const finalRerankedTop: HybridSearchResult[] = withIntent.slice(0, topK).map(r => ({
      filePath: r.filePath,
      score: r.score,
      summary: r.summary || '',
      bm25Score: r.bm25Score!,
      embeddingScore: r.embeddingScore!,
      graphScore: r.graphScore!,
      codeRelevanceScore: r.codeRelevanceScore!,
      fileTypeScore: r.fileTypeScore!,
    }));

    // Track promotions caused by reranking
    const preRerankOrder = hybridMergedTop.map((r, i) => ({ filePath: r.filePath, rank: i }));
    const filesPromotedByRerank = finalRerankedTop
      .map((r, i) => {
        const prev = preRerankOrder.find(p => p.filePath === r.filePath);
        if (prev !== undefined && prev.rank > i) {
          return { filePath: r.filePath, oldRank: prev.rank, newRank: i };
        }
        return null;
      })
      .filter((x): x is { filePath: string; oldRank: number; newRank: number } => x !== null);

    return {
      query,
      intent,
      latencyMs: Date.now() - startTime,
      bm25Top,
      embeddingTop,
      hybridMergedTop,
      finalRerankedTop,
      filesAddedByGraph,
      filesPromotedByRerank,
    };
  }

  /** Invalidate cached BM25 index (call when embedding manager rebuilds). */
  invalidate(): void {
    this.bm25Index = null;
  }
}
