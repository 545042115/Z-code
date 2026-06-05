import * as vscode from 'vscode';
import { ContextManager } from '../context/context-manager';
import { RetrievalDebugResult } from '../context/hybrid-retrieval';

const EXAMPLE_QUERIES = [
  'fix login issue',
  'payment timeout',
  'user authentication failure',
  'explain project architecture',
  'add logging to api layer',
];

export class RetrievalDebugger {
  constructor(private readonly contextManager: ContextManager) {}

  async runDebugQuery(query?: string): Promise<void> {
    const input = query || (await vscode.window.showInputBox({
      prompt: 'Enter a retrieval query to debug',
      placeHolder: 'e.g., fix login issue',
    }));

    if (!input) {
      return;
    }

    if (!this.contextManager.isInitialized()) {
      vscode.window.showWarningMessage('Coding Agent is still initializing. Please wait.');
      return;
    }

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Debugging retrieval for: ${input}`,
        cancellable: false,
      },
      async () => {
        const result = await this.contextManager.hybridRetrieval.debugSearch(input, { topK: 10 });
        const report = this.formatSingleQueryReport(result);
        const doc = await vscode.workspace.openTextDocument({
          content: report,
          language: 'markdown',
        });
        await vscode.window.showTextDocument(doc, { preview: true });
      }
    );
  }

  async runBatchEvaluation(): Promise<void> {
    if (!this.contextManager.isInitialized()) {
      vscode.window.showWarningMessage('Coding Agent is still initializing. Please wait.');
      return;
    }

    const channel = vscode.window.createOutputChannel('Coding Agent Retrieval Evaluation');
    channel.show(true);

    channel.appendLine('# Hybrid Retrieval Quality Evaluation');
    channel.appendLine(`Date: ${new Date().toISOString()}`);
    channel.appendLine(`Workspace: ${vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || 'unknown'}`);
    channel.appendLine('');

    const allResults: RetrievalDebugResult[] = [];

    for (const query of EXAMPLE_QUERIES) {
      channel.appendLine(`## Query: "${query}"`);
      channel.appendLine(`Intent: ${this.contextManager.hybridRetrieval['detectIntent'](query)}`);
      channel.appendLine('Running...');

      const result = await this.contextManager.hybridRetrieval.debugSearch(query, { topK: 10 });
      allResults.push(result);

      channel.appendLine(`Latency: ${result.latencyMs}ms`);
      channel.appendLine('');

      channel.appendLine('### BM25 Top 5');
      for (const r of result.bm25Top.slice(0, 5)) {
        channel.appendLine(`  ${r.score.toFixed(3)}  ${this.shortenPath(r.filePath)}`);
      }
      channel.appendLine('');

      channel.appendLine('### Embedding Top 5');
      for (const r of result.embeddingTop.slice(0, 5)) {
        channel.appendLine(`  ${r.score.toFixed(3)}  ${this.shortenPath(r.filePath)}`);
      }
      channel.appendLine('');

      channel.appendLine('### Final Hybrid Top 5');
      for (const r of result.finalRerankedTop.slice(0, 5)) {
        channel.appendLine(
          `  ${r.score.toFixed(3)}  ${this.shortenPath(r.filePath)}  (bm25:${r.bm25Score.toFixed(2)} emb:${r.embeddingScore.toFixed(2)} graph:${r.graphScore.toFixed(2)} code:${r.codeRelevanceScore.toFixed(2)} type:${r.fileTypeScore.toFixed(2)})`
        );
      }
      channel.appendLine('');

      if (result.filesAddedByGraph.length > 0) {
        channel.appendLine(`### Files Added by Graph Expansion (${result.filesAddedByGraph.length})`);
        for (const f of result.filesAddedByGraph.slice(0, 5)) {
          channel.appendLine(`  ${this.shortenPath(f)}`);
        }
        channel.appendLine('');
      }

      if (result.filesPromotedByRerank.length > 0) {
        channel.appendLine(`### Files Promoted by Rerank (${result.filesPromotedByRerank.length})`);
        for (const p of result.filesPromotedByRerank.slice(0, 5)) {
          channel.appendLine(`  #${p.oldRank + 1} → #${p.newRank + 1}  ${this.shortenPath(p.filePath)}`);
        }
        channel.appendLine('');
      }

      channel.appendLine('---');
      channel.appendLine('');
    }

    // Summary statistics
    const avgLatency = allResults.reduce((sum, r) => sum + r.latencyMs, 0) / allResults.length;
    const totalGraphAdded = allResults.reduce((sum, r) => sum + r.filesAddedByGraph.length, 0);
    const totalPromoted = allResults.reduce((sum, r) => sum + r.filesPromotedByRerank.length, 0);

    channel.appendLine('## Summary Statistics');
    channel.appendLine(`- Average latency: ${avgLatency.toFixed(1)}ms`);
    channel.appendLine(`- Total files added by graph expansion: ${totalGraphAdded}`);
    channel.appendLine(`- Total files promoted by reranking: ${totalPromoted}`);
    channel.appendLine(`- Queries evaluated: ${allResults.length}`);
    channel.appendLine('');
    channel.appendLine('Evaluation complete.');
  }

  private formatSingleQueryReport(result: RetrievalDebugResult): string {
    const lines: string[] = [];
    lines.push(`# Retrieval Debug Report: "${result.query}"`);
    lines.push('');
    lines.push(`**Detected intent:** ${result.intent}`);
    lines.push(`**Total latency:** ${result.latencyMs}ms`);
    lines.push('');

    lines.push('## 1. BM25 Top 10 (Lexical)');
    lines.push('');
    lines.push('| Rank | Score | File |');
    lines.push('|------|-------|------|');
    for (let i = 0; i < result.bm25Top.length; i++) {
      const r = result.bm25Top[i];
      lines.push(`| ${i + 1} | ${r.score.toFixed(3)} | ${this.shortenPath(r.filePath)} |`);
    }
    lines.push('');

    lines.push('## 2. Embedding Top 10 (Semantic)');
    lines.push('');
    lines.push('| Rank | Score | File |');
    lines.push('|------|-------|------|');
    for (let i = 0; i < result.embeddingTop.length; i++) {
      const r = result.embeddingTop[i];
      lines.push(`| ${i + 1} | ${r.score.toFixed(3)} | ${this.shortenPath(r.filePath)} |`);
    }
    lines.push('');

    lines.push('## 3. Hybrid Merged Top 10 (BM25 + Embedding)');
    lines.push('');
    lines.push('| Rank | Score | File |');
    lines.push('|------|-------|------|');
    for (let i = 0; i < result.hybridMergedTop.length; i++) {
      const r = result.hybridMergedTop[i];
      lines.push(`| ${i + 1} | ${r.score.toFixed(3)} | ${this.shortenPath(r.filePath)} |`);
    }
    lines.push('');

    lines.push('## 4. Final Reranked Top 10 (+ Graph + Code + Intent)');
    lines.push('');
    lines.push('| Rank | Final | BM25 | Emb | Graph | Code | Type | File |');
    lines.push('|------|-------|------|-----|-------|------|------|------|');
    for (let i = 0; i < result.finalRerankedTop.length; i++) {
      const r = result.finalRerankedTop[i];
      lines.push(
        `| ${i + 1} | ${r.score.toFixed(3)} | ${r.bm25Score.toFixed(2)} | ${r.embeddingScore.toFixed(2)} | ${r.graphScore.toFixed(2)} | ${r.codeRelevanceScore.toFixed(2)} | ${r.fileTypeScore.toFixed(2)} | ${this.shortenPath(r.filePath)} |`
      );
    }
    lines.push('');

    if (result.filesAddedByGraph.length > 0) {
      lines.push('## Files Added by Graph Expansion');
      lines.push('');
      for (const f of result.filesAddedByGraph) {
        lines.push(`- ${this.shortenPath(f)}`);
      }
      lines.push('');
    } else {
      lines.push('## Files Added by Graph Expansion');
      lines.push('*No new files were added by graph expansion for this query.*');
      lines.push('');
    }

    if (result.filesPromotedByRerank.length > 0) {
      lines.push('## Files Promoted by Reranking');
      lines.push('');
      lines.push('| File | Old Rank | New Rank |');
      lines.push('|------|----------|----------|');
      for (const p of result.filesPromotedByRerank) {
        lines.push(`| ${this.shortenPath(p.filePath)} | ${p.oldRank + 1} | ${p.newRank + 1} |`);
      }
      lines.push('');
    } else {
      lines.push('## Files Promoted by Reranking');
      lines.push('*No files were promoted by the final reranking step.*');
      lines.push('');
    }

    return lines.join('\n');
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
