// @ziner/runtime — Context Compressor
//
// Compresses context chunks before they reach the budget manager.
// This sits between IContextProvider.fetch() and BudgetManager.allocate(),
// reducing token usage by summarising or extracting only the relevant
// snippets from each chunk.
//
// Two strategies are supported:
//   1. Extractive — pull only the sentences/paragraphs most relevant to
//      the query (cheaper, no LLM needed)
//   2. Abstractive — use an LLM to summarise each chunk (higher quality,
//      but costs tokens and latency)

import type { ContextChunk } from '@ziner/contracts';

export type CompressionStrategy = 'extractive' | 'abstractive' | 'none';

export interface CompressionOptions {
  /** Which strategy to use. Default 'extractive'. */
  strategy?: CompressionStrategy;
  /** Target character count per chunk. Default 500. */
  targetCharsPerChunk?: number;
  /** Minimum chunk length to bother compressing. Default 800. */
  minCharsToCompress?: number;
  /** Number of relevant sentences to keep (extractive mode). Default 3. */
  extractiveSentences?: number;
  /**
   * Optional abstractive summarizer. Required for 'abstractive' strategy.
   * Takes (query, fullText) and returns a compressed version.
   */
  summarizer?: (query: string, text: string) => Promise<string>;
}

export interface CompressionResult {
  /** Compressed chunks (in same order as input). */
  chunks: ContextChunk[];
  /** Total chars before compression. */
  charsBefore: number;
  /** Total chars after compression. */
  charsAfter: number;
  /** Ratio of charsAfter / charsBefore (1.0 = no compression). */
  compressionRatio: number;
}

export class ContextCompressor {
  private readonly opts: Required<Omit<CompressionOptions, 'summarizer'>> & Pick<CompressionOptions, 'summarizer'>;

  constructor(opts: CompressionOptions = {}) {
    this.opts = {
      strategy: opts.strategy ?? 'extractive',
      targetCharsPerChunk: opts.targetCharsPerChunk ?? 500,
      minCharsToCompress: opts.minCharsToCompress ?? 800,
      extractiveSentences: opts.extractiveSentences ?? 3,
      summarizer: opts.summarizer,
    };
  }

  /**
   * Compress a list of context chunks relative to the query.
   * Returns the compressed chunks plus statistics.
   */
  async compress(chunks: ContextChunk[], query: string): Promise<CompressionResult> {
    const strategy = this.opts.strategy;

    if (strategy === 'none' || chunks.length === 0) {
      const total = chunks.reduce((sum, c) => sum + c.content.length, 0);
      return {
        chunks,
        charsBefore: total,
        charsAfter: total,
        compressionRatio: 1,
      };
    }

    const charsBefore = chunks.reduce((sum, c) => sum + c.content.length, 0);
    const compressed: ContextChunk[] = [];

    for (const chunk of chunks) {
      if (chunk.content.length < this.opts.minCharsToCompress) {
        compressed.push(chunk);
        continue;
      }

      try {
        const newContent = strategy === 'abstractive' && this.opts.summarizer
          ? await this._abstractive(chunk.content, query)
          : this._extractive(chunk.content, query);

        compressed.push({
          ...chunk,
          content: newContent,
          tags: [...chunk.tags, `compressed:${strategy}`],
        });
      } catch {
        // If compression fails, keep the original
        compressed.push(chunk);
      }
    }

    const charsAfter = compressed.reduce((sum, c) => sum + c.content.length, 0);
    return {
      chunks: compressed,
      charsBefore,
      charsAfter,
      compressionRatio: charsBefore > 0 ? charsAfter / charsBefore : 1,
    };
  }

  // ── Extractive compression ─────────────────────────────────────────

  private _extractive(text: string, query: string): string {
    const sentences = this._splitSentences(text);
    if (sentences.length <= this.opts.extractiveSentences) return text;

    const queryTerms = new Set(
      query.toLowerCase().split(/\s+/).filter((t) => t.length > 2),
    );

    // Score each sentence by keyword overlap with the query
    const scored = sentences.map((sentence, idx) => {
      const words = sentence.toLowerCase().split(/\s+/);
      let overlap = 0;
      for (const w of words) {
        if (queryTerms.has(w)) overlap++;
      }
      // Normalise by sentence length + position bonus (first/last sentences matter)
      const positionBonus = idx === 0 || idx === sentences.length - 1 ? 0.5 : 0;
      const score = overlap / Math.max(1, words.length) + positionBonus;
      return { sentence, idx, score };
    });

    // Pick top N sentences, then restore original order
    const top = scored
      .sort((a, b) => b.score - a.score)
      .slice(0, this.opts.extractiveSentences)
      .sort((a, b) => a.idx - b.idx);

    let result = top.map((t) => t.sentence).join(' ');

    // Enforce target char limit
    if (result.length > this.opts.targetCharsPerChunk) {
      result = result.slice(0, this.opts.targetCharsPerChunk - 3) + '...';
    }

    return result;
  }

  private _splitSentences(text: string): string[] {
    // Simple sentence splitter: split on . ! ? followed by space or end
    // Handles Chinese punctuation too.
    return text
      .split(/(?<=[.!?。！？])\s+|\n+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  // ── Abstractive compression ────────────────────────────────────────

  private async _abstractive(text: string, query: string): Promise<string> {
    if (!this.opts.summarizer) return text;
    const summary = await this.opts.summarizer(query, text);
    if (summary.length > this.opts.targetCharsPerChunk) {
      return summary.slice(0, this.opts.targetCharsPerChunk - 3) + '...';
    }
    return summary;
  }
}
