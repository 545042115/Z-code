// @z-assistant/runtime — embedding
//
// Pluggable embedding provider facade. The default `local` provider is a
// dependency-free deterministic embedding that is good enough for unit
// tests and offline demos. Production deployments should register a
// real provider (OpenAI, Cohere, sentence-transformers, etc.).
//
// The local provider uses a simple bag-of-ngrams hash: each word and
// 2-word ngram hashes into a fixed-size dense vector, which is then
// L2-normalized. It is deterministic, fast, and requires no model files.

import type { IEmbeddingProvider } from '@z-assistant/contracts';

export type { IEmbeddingProvider } from '@z-assistant/contracts';

export interface LocalEmbeddingOptions {
  /** Vector dimensions; default 384. */
  dimensions?: number;
  /** N-gram width; default 2 (unigrams + bigrams). */
  ngram?: number;
  /** Seed for deterministic hashing; default 0x9e3779b9. */
  seed?: number;
}

/** Simple hash function (Murmur-like 32-bit). */
function hash32(str: string, seed = 0x9e3779b9): number {
  let h = seed;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x5bd1e995);
    h ^= h >>> 13;
    h = Math.imul(h, 0x5bd1e995);
  }
  return h >>> 0;
}

function normalize(vec: number[]): number[] {
  let sum = 0;
  for (const v of vec) sum += v * v;
  const norm = Math.sqrt(sum) || 1;
  return vec.map((v) => v / norm);
}

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

function ngrams(words: string[], n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i <= words.length - n; i++) {
    out.push(words.slice(i, i + n).join(' '));
  }
  return out;
}

/** Create a deterministic, dependency-free local embedding provider. */
export function createLocalEmbeddingProvider(opts: LocalEmbeddingOptions = {}): IEmbeddingProvider {
  const dimensions = opts.dimensions ?? 384;
  const ngramWidth = opts.ngram ?? 2;
  const seed = opts.seed ?? 0x9e3779b9;

  function embedInto(text: string, vec: Float64Array): void {
    const words = tokens(text);
    const grams: string[] = [];
    for (let n = 1; n <= ngramWidth && n <= words.length; n++) {
      grams.push(...ngrams(words, n));
    }
    for (const g of grams) {
      const h = hash32(g, seed);
      const idx = h % dimensions;
      // Use two hashes for a rough signed value.
      const sign = (hash32(g + '$', seed) & 1) === 0 ? 1 : -1;
      const value = ((h / 0xffffffff) * sign) + 0.01;
      vec[idx] += value;
    }
  }

  return {
    name: 'local-embedding',
    dimensions,

    async embed(text: string): Promise<number[]> {
      const vec = new Float64Array(dimensions);
      embedInto(text, vec);
      return normalize(Array.from(vec));
    },

    async embedBatch(texts: string[]): Promise<number[][]> {
      return Promise.all(texts.map((t) => this.embed(t)));
    },

    async health() {
      return { ok: true, checkedAt: Date.now() };
    },
  };
}
