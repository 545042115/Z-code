import { SymbolIndex, SymbolEntry, SymbolKindName } from './symbol-index';
import { HybridSearchResult } from './hybrid-retrieval';

export interface SymbolRetrievalResult {
  symbol: SymbolEntry;
  fileRelevance: number;
  nameMatchScore: number;
  combinedScore: number;
}

export interface SymbolRetrievalOptions {
  maxSymbols?: number;
  intent?: string;
  currentFile?: string;
}

export class SymbolRetrieval {
  constructor(private readonly symbolIndex: SymbolIndex) {}

  search(
    query: string,
    topKFiles: HybridSearchResult[],
    options?: SymbolRetrievalOptions
  ): SymbolRetrievalResult[] {
    const maxSymbols = options?.maxSymbols ?? 20;
    const intent = options?.intent ?? 'other';
    const currentFile = options?.currentFile;

    const keywordSet = new Set(
      query
        .toLowerCase()
        .replace(/[^a-zA-Z0-9\u4e00-\u9fff_\-. ]/g, ' ')
        .split(/\s+/)
        .filter(t => t.length > 1)
    );

    const scoredSymbols = new Map<string, SymbolRetrievalResult>();

    // 路径 A：SymbolIndex 全局搜索
    for (const kw of keywordSet) {
      const matches = this.symbolIndex.search(kw, 30);
      for (const sym of matches) {
        const id = `${sym.filePath}#${sym.name}@${sym.line}`;
        const nameLower = sym.name.toLowerCase();
        let nameScore = 0;
        if (nameLower === kw) {
          nameScore = 100;
        } else if (nameLower.includes(kw)) {
          nameScore = 60;
        } else {
          nameScore = 30;
        }

        const existing = scoredSymbols.get(id);
        if (existing) {
          existing.nameMatchScore = Math.max(existing.nameMatchScore, nameScore);
          existing.combinedScore = this.computeCombinedScore(existing, intent);
        } else {
          const result: SymbolRetrievalResult = {
            symbol: sym,
            fileRelevance: 0,
            nameMatchScore: nameScore,
            combinedScore: 0,
          };
          result.combinedScore = this.computeCombinedScore(result, intent);
          scoredSymbols.set(id, result);
        }
      }
    }

    // 路径 B：TopK Files 中的符号提取
    for (const fileResult of topKFiles) {
      const symbols = this.symbolIndex.getSymbolsInFile(fileResult.filePath);
      for (const sym of symbols) {
        const id = `${sym.filePath}#${sym.name}@${sym.line}`;
        let nameScore = 0;
        const nameLower = sym.name.toLowerCase();
        for (const kw of keywordSet) {
          if (nameLower === kw) {
            nameScore = Math.max(nameScore, 80);
          } else if (nameLower.includes(kw)) {
            nameScore = Math.max(nameScore, 40);
          }
        }

        const existing = scoredSymbols.get(id);
        if (existing) {
          existing.fileRelevance = Math.max(existing.fileRelevance, fileResult.score * 100);
          existing.combinedScore = this.computeCombinedScore(existing, intent);
        } else if (nameScore > 0) {
          const result: SymbolRetrievalResult = {
            symbol: sym,
            fileRelevance: fileResult.score * 100,
            nameMatchScore: nameScore,
            combinedScore: 0,
          };
          result.combinedScore = this.computeCombinedScore(result, intent);
          scoredSymbols.set(id, result);
        }
      }
    }

    // 路径 C：currentFile 加权
    if (currentFile) {
      const symbols = this.symbolIndex.getSymbolsInFile(currentFile);
      for (const sym of symbols) {
        const id = `${sym.filePath}#${sym.name}@${sym.line}`;
        const existing = scoredSymbols.get(id);
        if (existing) {
          existing.fileRelevance += 15;
          existing.combinedScore = this.computeCombinedScore(existing, intent);
        }
      }
    }

    return Array.from(scoredSymbols.values())
      .sort((a, b) => b.combinedScore - a.combinedScore)
      .slice(0, maxSymbols);
  }

  private computeCombinedScore(result: SymbolRetrievalResult, intent: string): number {
    let kindBonus = 0;
    switch (intent) {
      case 'bug_fix':
        if (['function', 'method'].includes(result.symbol.kind)) {
          kindBonus = 15;
        }
        break;
      case 'feature_add':
        if (['class', 'interface'].includes(result.symbol.kind)) {
          kindBonus = 15;
        }
        break;
      case 'refactor':
        if (['class', 'module', 'interface'].includes(result.symbol.kind)) {
          kindBonus = 15;
        }
        break;
      case 'testing':
        if (['function', 'method', 'class'].includes(result.symbol.kind)) {
          kindBonus = 10;
        }
        break;
    }
    return result.nameMatchScore + result.fileRelevance * 0.3 + kindBonus;
  }
}
