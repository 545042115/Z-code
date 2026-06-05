export interface CandidateData {
  bm25Score?: number;
  embeddingScore?: number;
  graphScore?: number;
  codeRelevanceScore?: number;
  fileTypeScore?: number;
  summary?: string;
}

export interface RankedDocument {
  filePath: string;
  bm25Score: number;
  embeddingScore: number;
  graphScore: number;
  codeRelevanceScore: number;
  fileTypeScore: number;
  finalScore: number;
  summary?: string;
}

export type RetrievalIntent = 'modification' | 'bug_fix' | 'project_understanding' | 'explanation' | 'neutral';

export interface RerankerOptions {
  bm25Weight?: number;
  embeddingWeight?: number;
  graphWeight?: number;
  codeRelevanceWeight?: number;
  fileTypeWeight?: number;
  intent?: RetrievalIntent;
}

export interface IntentWeights {
  bm25: number;
  embedding: number;
  graph: number;
  codeRelevance: number;
  fileType: number;
}

export class Reranker {
  /**
   * Intent-aware dynamic weights.
   * modification:  code-heavy tasks need high code relevance
   * bug_fix:       graph relationships help find affected code
   * project_understanding: semantic search dominates
   * explanation:   semantic + BM25 balanced
   * neutral:       balanced fallback
   */
  private static readonly INTENT_WEIGHTS: Record<RetrievalIntent, IntentWeights> = {
    modification:          { bm25: 0.15, embedding: 0.15, graph: 0.20, codeRelevance: 0.40, fileType: 0.10 },
    bug_fix:               { bm25: 0.10, embedding: 0.15, graph: 0.30, codeRelevance: 0.35, fileType: 0.10 },
    project_understanding: { bm25: 0.30, embedding: 0.40, graph: 0.20, codeRelevance: 0.05, fileType: 0.05 },
    explanation:           { bm25: 0.25, embedding: 0.35, graph: 0.15, codeRelevance: 0.10, fileType: 0.15 },
    neutral:               { bm25: 0.20, embedding: 0.30, graph: 0.20, codeRelevance: 0.20, fileType: 0.10 },
  };

  private getWeights(options: RerankerOptions): IntentWeights {
    const intent = options.intent ?? 'neutral';
    const base = Reranker.INTENT_WEIGHTS[intent];

    // Allow explicit overrides per-call while keeping intent as default
    return {
      bm25: options.bm25Weight ?? base.bm25,
      embedding: options.embeddingWeight ?? base.embedding,
      graph: options.graphWeight ?? base.graph,
      codeRelevance: options.codeRelevanceWeight ?? base.codeRelevance,
      fileType: options.fileTypeWeight ?? base.fileType,
    };
  }

  /**
   * Rerank merged candidates using an intent-aware weighted linear combination.
   */
  rerank(
    candidates: Map<string, CandidateData>,
    options: RerankerOptions = {}
  ): RankedDocument[] {
    const w = this.getWeights(options);

    const results: RankedDocument[] = [];

    for (const [filePath, scores] of candidates) {
      const bm25 = scores.bm25Score ?? 0;
      const emb = scores.embeddingScore ?? 0;
      const graph = scores.graphScore ?? 0;
      const codeRel = scores.codeRelevanceScore ?? 0;
      const fileType = scores.fileTypeScore ?? 0;
      const final = w.bm25 * bm25 + w.embedding * emb + w.graph * graph + w.codeRelevance * codeRel + w.fileType * fileType;

      results.push({
        filePath,
        bm25Score: Math.round(bm25 * 1000) / 1000,
        embeddingScore: Math.round(emb * 1000) / 1000,
        graphScore: Math.round(graph * 1000) / 1000,
        codeRelevanceScore: Math.round(codeRel * 1000) / 1000,
        fileTypeScore: Math.round(fileType * 1000) / 1000,
        finalScore: Math.round(final * 1000) / 1000,
        summary: scores.summary,
      });
    }

    return results.sort((a, b) => b.finalScore - a.finalScore);
  }
}
