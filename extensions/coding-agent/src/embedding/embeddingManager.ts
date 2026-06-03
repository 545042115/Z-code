import * as vscode from 'vscode';
import { WorkspaceScanner } from '../context/workspaceScanner';

export interface EmbeddingVector {
  filePath: string;
  vector: Map<string, number>;
  tokens: string[];
  summary: string;
}

export interface EmbeddingResult {
  filePath: string;
  score: number;
  summary: string;
}

export class EmbeddingManager {
  private vectors: EmbeddingVector[] = [];
  private documentFrequency: Map<string, number> = new Map();
  private totalDocuments: number = 0;
  private built = false;
  private readonly TOP_K_DEFAULT = 10;

  private readonly TARGET_PATTERNS = [
    /architect|developing|design|overview|structure/i,
    /package\.json$/,
    /tsconfig\./,
    /webpack\.config/,
    /Dockerfile/,
    /docker-compose/,
    /Makefile$/,
    /CMakeLists\.txt$/,
    /vite\.config/,
    /\.env/,
    /server|api|route|controller|handler|service/i,
    /config|setting/i,
    /main\.(ts|js|py|go)$/,
    /index\.(ts|js)$/,
    /app\.(ts|js|py)$/,
    /core|util|helper|common|shared|base/i,
    /plugin|extension|module|provider/i,
    /readme\.md$/i,
  ];

  private readonly EXCLUDE_PATTERNS = [
    /node_modules/,
    /\.git/,
    /dist/,
    /out/,
    /build/,
    /\.test\./,
    /\.spec\./,
    /__tests__/,
    /\/Pods\//,
    /\/Carthage\//,
    /\/vendor\/bundle\//,
    /\.cache/,
    /\.gradle/,
    /\/target\//,
    /DerivedData/,
    /\.venv/,
    /\/venv\//,
    /\/env\//,
    /\.tox/,
  ];

  constructor(private readonly scanner: WorkspaceScanner) {}

  get isBuilt(): boolean {
    return this.built;
  }

  async build(): Promise<void> {
    const allFiles = this.scanner.getFiles();
    const targetFiles = allFiles.filter(f => this.shouldIndex(f.path));

    this.vectors = [];
    this.documentFrequency = new Map();
    this.totalDocuments = 0;

    // Phase 1: 收集所有文档的词频并统计文档频率
    const rawVectors: { filePath: string; termFreq: Map<string, number>; tokens: string[]; summary: string }[] = [];

    for (const file of targetFiles) {
      try {
        const content = await this.readFileContent(file.path);
        if (!content || content.length < 20) continue;

        const { vector: termFreq, tokens } = this.buildTermFrequency(content);
        const summary = this.extractSummary(content);

        // 统计文档频率
        for (const term of termFreq.keys()) {
          this.documentFrequency.set(term, (this.documentFrequency.get(term) || 0) + 1);
        }
        this.totalDocuments++;

        rawVectors.push({ filePath: file.path, termFreq, tokens, summary });
      } catch {
        continue;
      }
    }

    // Phase 2: 计算 TF-IDF 权重
    for (const raw of rawVectors) {
      const tfidfVector = new Map<string, number>();
      for (const [term, tf] of raw.termFreq) {
        const df = this.documentFrequency.get(term) || 1;
        const idf = Math.log(this.totalDocuments / df) + 1;
        tfidfVector.set(term, tf * idf);
      }
      this.vectors.push({
        filePath: raw.filePath,
        vector: tfidfVector,
        tokens: raw.tokens,
        summary: raw.summary,
      });
    }

    this.built = true;
  }

  search(query: string, topK: number = this.TOP_K_DEFAULT): EmbeddingResult[] {
    if (!this.built || this.vectors.length === 0) return [];

    const { vector: queryTf } = this.buildTermFrequency(query);
    // 对查询也应用 IDF
    const queryVector = new Map<string, number>();
    for (const [term, tf] of queryTf) {
      const df = this.documentFrequency.get(term) || 1;
      const idf = Math.log(this.totalDocuments / df) + 1;
      queryVector.set(term, tf * idf);
    }

    const scored: { filePath: string; score: number; summary: string }[] = [];

    for (const vec of this.vectors) {
      const score = this.cosineSimilarity(queryVector, vec.vector);
      const boost = this.getPathBoost(query, vec.filePath);
      scored.push({
        filePath: vec.filePath,
        score: score + boost,
        summary: vec.summary,
      });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK).map(s => ({
      filePath: s.filePath,
      score: Math.round(s.score * 1000) / 1000,
      summary: s.summary,
    }));
  }

  searchByModule(moduleTag: string, topK: number = 5): EmbeddingResult[] {
    if (!this.built) return [];

    const results: EmbeddingResult[] = [];
    for (const vec of this.vectors) {
      const lowerPath = vec.filePath.replace(/\\/g, '/').toLowerCase();
      if (lowerPath.includes(moduleTag.toLowerCase())) {
        results.push({
          filePath: vec.filePath,
          score: 1.0,
          summary: vec.summary,
        });
      }
    }

    return results.slice(0, topK);
  }

  private shouldIndex(filePath: string): boolean {
    for (const ex of this.EXCLUDE_PATTERNS) {
      if (ex.test(filePath)) return false;
    }
    for (const pat of this.TARGET_PATTERNS) {
      if (pat.test(filePath)) return true;
    }
    const ext = filePath.split('.').pop()?.toLowerCase();
    if (ext && ['ts', 'tsx', 'js', 'jsx', 'py', 'go', 'rs', 'java', 'json', 'yaml', 'yml', 'toml', 'md', 'txt'].includes(ext)) {
      const basename = filePath.split(/[/\\]/).pop()?.toLowerCase() || '';
      return !/\.(test|spec)\./.test(basename);
    }
    return false;
  }

  private async readFileContent(filePath: string): Promise<string> {
    try {
      const uri = vscode.Uri.file(filePath);
      const doc = await vscode.workspace.openTextDocument(uri);
      return doc.getText();
    } catch {
      return '';
    }
  }

  private buildTermFrequency(text: string): { vector: Map<string, number>; tokens: string[] } {
    const tokens = this.tokenize(text);
    const termFreq = new Map<string, number>();

    for (const token of tokens) {
      termFreq.set(token, (termFreq.get(token) || 0) + 1);
    }

    const maxFreq = Math.max(...termFreq.values(), 1);
    const tfMap = new Map<string, number>();
    for (const [term, freq] of termFreq) {
      tfMap.set(term, freq / maxFreq);
    }

    return { vector: tfMap, tokens };
  }

  private tokenize(text: string): string[] {
    const lower = text.toLowerCase();
    const tokens: string[] = [];

    const codeWords = lower.match(/[a-z_$][a-z0-9_$]{1,}/g);
    if (codeWords) tokens.push(...codeWords);

    const chineseChars = lower.match(/[\u4e00-\u9fff]{2,}/g);
    if (chineseChars) {
      for (const c of chineseChars) {
        for (let i = 0; i < c.length - 1; i++) {
          tokens.push(c.substring(i, i + 2));
        }
      }
    }

    const stopWords = new Set([
      'the', 'this', 'that', 'and', 'for', 'with', 'from', 'function',
      'const', 'let', 'var', 'return', 'import', 'export', 'default',
      'async', 'await', 'true', 'false', 'null', 'undefined', 'void',
      'class', 'interface', 'type', 'extends', 'implements', 'new',
      'try', 'catch', 'throw', 'if', 'else', 'switch', 'case', 'break',
      'while', 'for', 'of', 'in', 'do', 'continue', 'typeof', 'instanceof',
      'public', 'private', 'protected', 'static', 'readonly', 'keyof',
      'number', 'string', 'boolean', 'any', 'never', 'unknown', 'object',
      'int', 'float', 'double', 'char', 'byte', 'short', 'long',
      'nil', 'none', 'true', 'false', 'none', 'self', 'super',
      'has', 'have', 'been', 'were', 'was', 'are', 'is', 'be', 'being',
      'will', 'would', 'could', 'should', 'can', 'may', 'might', 'shall',
      'about', 'above', 'after', 'again', 'all', 'also', 'any', 'because',
      'been', 'before', 'being', 'between', 'both', 'but', 'cannot', 'did',
      'does', 'done', 'each', 'else', 'every', 'few', 'find', 'first',
      'get', 'got', 'great', 'had', 'has', 'have', 'here', 'how', 'into',
      'just', 'know', 'like', 'long', 'look', 'made', 'make', 'many',
      'more', 'most', 'much', 'must', 'need', 'never', 'next', 'now',
      'only', 'other', 'our', 'over', 'own', 'part', 'said', 'same',
      'see', 'she', 'should', 'show', 'side', 'some', 'such', 'take',
      'than', 'that', 'their', 'them', 'then', 'there', 'these', 'they',
      'thing', 'think', 'those', 'three', 'through', 'time', 'too',
      'under', 'upon', 'use', 'used', 'uses', 'using', 'very', 'want',
      'way', 'well', 'what', 'when', 'where', 'which', 'while', 'who',
      'why', 'will', 'with', 'work', 'would', 'year',
    ]);

    return tokens.filter(t => t.length > 2 && !stopWords.has(t));
  }

  private cosineSimilarity(a: Map<string, number>, b: Map<string, number>): number {
    let dotProduct = 0;
    let magA = 0;
    let magB = 0;

    for (const [term, weight] of a) {
      magA += weight * weight;
      const bWeight = b.get(term) || 0;
      if (bWeight > 0) {
        dotProduct += weight * bWeight;
      }
    }

    for (const [, weight] of b) {
      magB += weight * weight;
    }

    const magnitude = Math.sqrt(magA) * Math.sqrt(magB);
    return magnitude === 0 ? 0 : dotProduct / magnitude;
  }

  private getPathBoost(query: string, filePath: string): number {
    const lowerQuery = query.toLowerCase();
    const lowerPath = filePath.replace(/\\/g, '/').toLowerCase();

    let boost = 0;
    const queryTokens = lowerQuery.split(/\s+/);

    for (const token of queryTokens) {
      if (token.length < 3) continue;

      if (lowerPath.includes(token)) {
        boost += 0.2;
      }

      const basename = lowerPath.split('/').pop() || '';
      if (basename.includes(token)) {
        boost += 0.3;
      }
    }

    if (/config|setting|setup/i.test(lowerPath) && /config|setting|setup/i.test(lowerQuery)) {
      boost += 0.1;
    }
    if (/server|api|route/i.test(lowerPath) && /server|api|route/i.test(lowerQuery)) {
      boost += 0.1;
    }
    if (/core|util|common/i.test(lowerPath) && /core|util|common/i.test(lowerQuery)) {
      boost += 0.1;
    }

    if (this.isProjectUnderstandingQuery(lowerQuery)) {
      if (/readme\.md$/i.test(lowerPath)) {
        boost -= 0.25;
      }
      if (/\/(main|index|app|entry)\.(ts|js|tsx|jsx|py|go|rs|java)$/i.test(lowerPath)) {
        boost += 0.2;
      }
      if (/\/(agent|core|engine|service|server|router)\.(ts|js|tsx|jsx|py|go|rs|java)$/i.test(lowerPath)) {
        boost += 0.15;
      }
      if (/src\/(agent|core|engine|service|server|router)\//i.test(lowerPath)) {
        boost += 0.1;
      }
    }

    return boost;
  }

  private isProjectUnderstandingQuery(query: string): boolean {
    return /这个项目是干什么|项目是干什么|项目是做什么|介绍项目|项目简介|项目介绍|解释项目|about this project|项目功能|项目模块|项目作用|项目说明|项目用途|项目结构|目录结构|项目架构|分析项目|分析架构|项目组织|查看.*项目.*作用|查看.*项目.*功能|查看.*项目.*用途|当前项目.*作用|当前项目.*功能|当前项目.*用途|项目概述|项目概况/i.test(query);
  }

  private extractSummary(content: string): string {
    const lines = content.split('\n').filter(l => l.trim().length > 0);
    const summaryLines: string[] = [];

    for (const line of lines.slice(0, 30)) {
      const trimmed = line.trim();
      if (/^#/.test(trimmed) || /^\/\//.test(trimmed) || /^\/\*/.test(trimmed)) {
        summaryLines.push(trimmed.replace(/^#+\s*/, '').replace(/^\/\/\s*/, '').replace(/^\/\*\*?\s*/, ''));
      } else if (/^(export\s+)?(class|interface|function|enum|type|const)\s/.test(trimmed)) {
        summaryLines.push(trimmed);
      }
      if (summaryLines.length >= 10) break;
    }

    return summaryLines.join('\n') || content.slice(0, 200);
  }

  getStats(): { totalVectors: number; targetFiles: string[] } {
    return {
      totalVectors: this.vectors.length,
      targetFiles: this.vectors.map(v => v.filePath),
    };
  }
}
