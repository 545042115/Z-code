// @z-assistant/agent-research — Research Agent implementation.
//
// Enhanced loop: plan queries → cached parallel search → parallel fetch →
// source scoring/deduplication → recursive expansion → cited report → mind map.

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  IAgent,
  ILLMProvider,
  LLMMessage,
  ModelSpec,
  TaskContext,
  AgentResult,
  AgentMetrics,
} from '@z-assistant/contracts';
import type { TraceManager } from '@z-assistant/trace';

export interface ResearchAgentOptions {
  llmProvider: ILLMProvider;
  model: ModelSpec;
  /** Search provider: (query, maxResults) => array of {title, url, snippet} */
  searchProvider: (query: string, maxResults: number) => Promise<Array<{ title: string; url: string; snippet?: string }>>;
  /** Fetch provider: (url, maxLength) => text content */
  fetchProvider: (url: string, maxLength: number) => Promise<string>;
  /**
   * Optional browser-based fetch provider. When set, URLs that are likely
   * to require JavaScript (SPA, login, dynamic pricing) will be fetched
   * via the browser instead of the simple fetchProvider. Also used as
   * fallback when fetchProvider returns empty content.
   * Signature: (url: string) => Promise<{ title: string; content: string }>
   */
  browserFetchProvider?: (url: string) => Promise<{ title: string; content: string }>;
  maxQueries?: number;
  maxResultsPerQuery?: number;
  maxPagesToFetch?: number;
  maxReportTokens?: number;
  /** Max research iterations (query → fetch → reflect). Default 1. */
  maxIterations?: number;
  /** Directory for persistent search-result cache. If omitted, caching is disabled. */
  cacheDir?: string;
  /** Cache TTL in ms. Default 24 hours. */
  cacheTtlMs?: number;
  /** Optional trace manager for emitting spans. */
  traceManager?: TraceManager;
}

export interface SearchResult {
  query: string;
  title: string;
  url: string;
  snippet?: string;
}

export interface FetchedPage {
  url: string;
  title: string;
  content: string;
  score: number;
}

export interface ResearchReport {
  /** Markdown report with inline citation markers like [1], [2]. */
  markdown: string;
  /** Numbered source list matching the citation markers. */
  sources: { index: number; title: string; url: string }[];
  /** Queries that were executed across all iterations. */
  queries: string[];
  /** Whether the agent judged the collected information sufficient. */
  satisfied: boolean;
  /** Mermaid mindmap diagram (text) generated from the report. */
  mindMap?: string;
  /** Plain-text hierarchical mind map (fallback / preview). */
  mindMapText?: string;
}

interface SearchCacheEntry {
  query: string;
  fetchedAt: number;
  lastAccessed: number;
  results: SearchResult[];
  ttlMs: number;
}

const RESEARCH_KEYWORDS = [
  'research', 'investigate', 'survey', 'study', 'analyze',
  '调研', '研究', '综述', '调查', '分析',
  'search for', 'find out', 'look up', 'gather information',
  '搜索', '查找', '查找资料', '收集资料',
  'report on', 'write a report', 'summary of', 'overview of',
  '报告', '总结', '概述',
];

/** URL patterns that typically require JavaScript rendering. */
const JS_REQUIRED_PATTERNS = [
  '.hotel', '.booking', '.airbnb', '.trip.com', '.ctrip', '.fliggy',
  '.meituan', '.dianping', '.taobao', '.tmall', '.jd.com',
  '.google.com/maps', '.amap.com', '.gaode.com',
  'maps.', 'map.',
  'login', 'signin', 'auth',
  '/search?', '/s?',
];
const HIGH_QUALITY_DOMAINS = new Set([
  'wikipedia.org',
  'github.com',
  'arxiv.org',
  'medium.com',
  'substack.com',
  'nytimes.com',
  'reuters.com',
  'bloomberg.com',
  'theguardian.com',
  'bbc.com',
  'apnews.com',
  'techcrunch.com',
  'theverge.com',
  'cnbc.com',
  'forbes.com',
  'zhihu.com',
  'jianshu.com',
  'csdn.net',
  'csdn.com',
  'baidu.com',
]);

export function createResearchAgent(opts: ResearchAgentOptions): ResearchAgent {
  return new ResearchAgent(opts);
}

export class ResearchAgent implements IAgent {
  name = 'research';
  role = 'Deep Research Agent';
  capabilities = [
    'web.search',
    'web.fetch',
    'research.synthesize',
    'report.write',
    'information.gather',
    'source.rank',
    'recursive.research',
    'cache.search',
    'mindmap.generate',
  ];
  dependencies: string[] = [];
  modelPreference?: ModelSpec;

  private llm: ILLMProvider;
  private model: ModelSpec;
  private searchProvider: ResearchAgentOptions['searchProvider'];
  private fetchProvider: ResearchAgentOptions['fetchProvider'];
  private browserFetchProvider?: ResearchAgentOptions['browserFetchProvider'];
  private maxQueries: number;
  private maxResultsPerQuery: number;
  private maxPagesToFetch: number;
  private maxReportTokens: number;
  private maxIterations: number;
  private cache?: SearchCache;
  private traceManager?: TraceManager;

  constructor(opts: ResearchAgentOptions) {
    this.llm = opts.llmProvider;
    this.model = opts.model;
    this.searchProvider = opts.searchProvider;
    this.fetchProvider = opts.fetchProvider;
    this.browserFetchProvider = opts.browserFetchProvider;
    this.maxQueries = opts.maxQueries ?? 3;
    this.maxResultsPerQuery = opts.maxResultsPerQuery ?? 5;
    this.maxPagesToFetch = opts.maxPagesToFetch ?? 5;
    this.maxReportTokens = opts.maxReportTokens ?? 2048;
    this.maxIterations = opts.maxIterations ?? 1;
    this.modelPreference = opts.model;
    this.traceManager = opts.traceManager;
    if (opts.cacheDir) {
      this.cache = new SearchCache(opts.cacheDir, opts.cacheTtlMs);
    }
  }

  canHandle(ctx: TaskContext): number {
    const task = ctx.task.toLowerCase();
    const hits = RESEARCH_KEYWORDS.filter((kw) => task.includes(kw.toLowerCase()));
    // Base score 0.4; boost by keyword hits, capped at 0.95.
    return Math.min(0.95, 0.4 + hits.length * 0.12);
  }

  async execute(ctx: TaskContext): Promise<AgentResult> {
    const startTime = Date.now();
    const metrics: AgentMetrics = {
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      durationMs: 0,
      llmCalls: 0,
      toolCalls: 0,
    };

    const tracker = this.traceManager?.active();
    const span = tracker?.startSpan({
      name: 'agent:research',
      type: 'agent',
      input: { task: ctx.task, maxIterations: this.maxIterations },
    });

    try {
      const allQueries: string[] = [];
      const allResults: SearchResult[] = [];
      const allPages: FetchedPage[] = [];

      // Initial query plan.
      const queryPlan = await this.planQueries(ctx.task, metrics, ctx.signal);
      let queries = queryPlan.queries.slice(0, this.maxQueries);

      for (let iteration = 0; iteration < this.maxIterations; iteration++) {
        if (ctx.signal?.aborted) break;
        if (queries.length === 0) break;

        allQueries.push(...queries);

        // Parallel search across all queries (with cache fallback).
        const searchBatches = await Promise.all(
          queries.map((q) => this.search(q, metrics, ctx.signal)),
        );
        for (const batch of searchBatches) {
          allResults.push(...batch.slice(0, this.maxResultsPerQuery));
        }

        // Deduplicate by URL and select top pages by score.
        const seenUrls = new Set(allPages.map((p) => p.url));
        const newResults = allResults.filter((r) => !seenUrls.has(r.url));
        const rankedUrls = this.rankAndDeduplicateUrls(newResults, ctx.task).slice(0, this.maxPagesToFetch);

        // Parallel fetch.
        const fetched = (
          await Promise.all(
            rankedUrls.map((url) => this.fetchPage(url, allResults, metrics, ctx.signal)),
          )
        ).filter((p): p is FetchedPage => p !== null);

        for (const page of fetched) {
          if (!seenUrls.has(page.url)) {
            allPages.push(page);
            seenUrls.add(page.url);
          }
        }

        // On intermediate iterations, ask the model whether we need more queries.
        if (iteration < this.maxIterations - 1 && allPages.length > 0) {
          const reflection = await this.reflectOnCoverage(
            ctx.task,
            allQueries,
            allPages,
            metrics,
            ctx.signal,
          );
          queries = reflection.followUpQueries.slice(0, this.maxQueries);
          if (reflection.satisfied) break;
        } else {
          break;
        }
      }

      // Generate structured report with citations.
      const report = await this.synthesizeReport(ctx.task, allQueries, allPages, metrics, ctx.signal);

      // Generate mind map from the report.
      const { mindMap, mindMapText } = await this.generateMindMap(ctx.task, report, metrics, ctx.signal);
      report.mindMap = mindMap;
      report.mindMapText = mindMapText;

      // Publish artifacts to shared state for downstream agents.
      ctx.sharedState.set('research.queries', allQueries, this.name);
      ctx.sharedState.set('research.results', allResults, this.name);
      ctx.sharedState.set(
        'research.pages',
        allPages.map((p) => ({ url: p.url, title: p.title, score: p.score })),
        this.name,
      );
      ctx.sharedState.set('research.report', report, this.name);
      if (mindMap) {
        ctx.sharedState.set('research.mindMap', mindMap, this.name);
      }

      span?.setOutput({
        ok: true,
        queries: allQueries.length,
        pages: allPages.length,
        satisfied: report.satisfied,
      });
      span?.end();

      metrics.durationMs = Date.now() - startTime;
      return {
        ok: true,
        output: report.markdown,
        artifacts: {
          'research.report': report.markdown,
          'research.reportJson': report,
          'research.sources': report.sources,
          'research.queries': allQueries,
          'research.mindMap': mindMap,
          'research.mindMapText': mindMapText,
        },
        metrics,
      };
    } catch (err: unknown) {
      span?.fail({ code: 'RESEARCH_ERROR', message: err instanceof Error ? err.message : String(err) });
      span?.end();
      metrics.durationMs = Date.now() - startTime;
      return {
        ok: false,
        error: {
          code: 'RESEARCH_ERROR',
          message: err instanceof Error ? err.message : String(err),
        },
        metrics,
      };
    }
  }

  private async planQueries(
    task: string,
    metrics: AgentMetrics,
    signal?: AbortSignal,
  ): Promise<{ queries: string[] }> {
    const messages: LLMMessage[] = [
      {
        role: 'system',
        content:
          'You are a research planner. Given a user request, produce up to 5 concise web search queries that will gather the most relevant information. Respond with a JSON object: {"queries": ["...", "..."]}.',
      },
      { role: 'user', content: task },
    ];

    const res = await this.llm.generate({
      model: this.model,
      messages,
      jsonMode: true,
      maxTokens: 512,
      signal,
    });
    metrics.llmCalls += 1;
    metrics.tokensIn += res.usage.tokensIn;
    metrics.tokensOut += res.usage.tokensOut;
    metrics.costUsd += res.costUsd ?? 0;

    try {
      const parsed = JSON.parse(res.message.content ?? '{}');
      const queries = Array.isArray(parsed.queries)
        ? parsed.queries.filter((q: unknown) => typeof q === 'string')
        : [];
      return { queries };
    } catch {
      return { queries: [task] };
    }
  }

  private async reflectOnCoverage(
    task: string,
    queries: string[],
    pages: FetchedPage[],
    metrics: AgentMetrics,
    signal?: AbortSignal,
  ): Promise<{ satisfied: boolean; followUpQueries: string[] }> {
    const summary = pages
      .map((p, i) => `[${i + 1}] ${p.title} (${p.url})\n${p.content.slice(0, 600)}`)
      .join('\n\n');

    const messages: LLMMessage[] = [
      {
        role: 'system',
        content:
          'You are a research critic. Given the original task and the sources collected so far, decide whether the information is sufficient and what follow-up search queries would fill remaining gaps. Respond with JSON: {"satisfied": true|false, "followUpQueries": ["..."]}.',
      },
      {
        role: 'user',
        content: `Task: ${task}\n\nQueries already run: ${queries.join('; ')}\n\nSources collected:\n\n${summary}`,
      },
    ];

    const res = await this.llm.generate({
      model: this.model,
      messages,
      jsonMode: true,
      maxTokens: 512,
      signal,
    });
    metrics.llmCalls += 1;
    metrics.tokensIn += res.usage.tokensIn;
    metrics.tokensOut += res.usage.tokensOut;
    metrics.costUsd += res.costUsd ?? 0;

    try {
      const parsed = JSON.parse(res.message.content ?? '{}');
      return {
        satisfied: parsed.satisfied === true,
        followUpQueries: Array.isArray(parsed.followUpQueries)
          ? parsed.followUpQueries.filter((q: unknown) => typeof q === 'string')
          : [],
      };
    } catch {
      return { satisfied: true, followUpQueries: [] };
    }
  }

  private async search(
    query: string,
    metrics: AgentMetrics,
    signal?: AbortSignal,
  ): Promise<SearchResult[]> {
    if (signal?.aborted) return [];

    // Try cache first.
    const cached = await this.cache?.get(query);
    if (cached) {
      return cached;
    }

    const results = await this.searchProvider(query, this.maxResultsPerQuery);
    metrics.toolCalls += 1;
    const normalized = results.map((r) => ({ query, ...r }));
    await this.cache?.set(query, normalized);
    return normalized;
  }

  private rankAndDeduplicateUrls(results: SearchResult[], task: string): string[] {
    const byUrl = new Map<string, SearchResult>();
    for (const r of results) {
      // Keep the first (highest-ranked) result for each URL.
      if (!byUrl.has(r.url)) byUrl.set(r.url, r);
    }

    const scored = Array.from(byUrl.values()).map((r) => ({
      url: r.url,
      score: this.scoreSource(r.url, r.snippet ?? r.title, task),
    }));

    scored.sort((a, b) => b.score - a.score);
    return scored.map((s) => s.url);
  }

  private scoreSource(url: string, content: string, task: string): number {
    let score = 0.2; // baseline

    // Domain authority.
    try {
      const host = new URL(url).hostname.toLowerCase();
      if (host.endsWith('.gov') || host.endsWith('.edu') || host.endsWith('.ac.uk') || host.endsWith('.ac.cn')) {
        score += 0.25;
      }
      for (const domain of HIGH_QUALITY_DOMAINS) {
        if (host === domain || host.endsWith(`.${domain}`)) {
          score += 0.15;
          break;
        }
      }
    } catch {
      // malformed URL, keep baseline
    }

    // Content coverage (length and keyword match).
    const text = `${content} ${url}`.toLowerCase();
    const taskWords = task.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
    const matches = taskWords.filter((w) => text.includes(w)).length;
    score += (matches / Math.max(1, taskWords.length)) * 0.35;
    score += Math.min(0.2, content.length / 15000);

    return Math.min(1, score);
  }

  private async fetchPage(
    url: string,
    results: SearchResult[],
    metrics: AgentMetrics,
    signal?: AbortSignal,
  ): Promise<FetchedPage | null> {
    if (signal?.aborted) return null;

    const title = results.find((r) => r.url === url)?.title ?? url;
    const needsBrowser = this.browserFetchProvider != null && this.needsBrowserForUrl(url);

    // If the URL likely requires JS, go straight to the browser.
    if (needsBrowser) {
      try {
        const page = await this.browserFetchProvider!(url);
        if (signal?.aborted) return null;
        metrics.toolCalls += 1;
        return { url, title: page.title || title, content: page.content, score: 0 };
      } catch {
        // Fall through to simple fetch as fallback.
      }
    }

    // Simple fetch (no JS).
    try {
      const content = await this.fetchProvider(url, 8000);
      if (signal?.aborted) return null;
      metrics.toolCalls += 1;

      // If content is empty/too short and we have a browser provider, try that.
      if (content.length < 200 && this.browserFetchProvider != null) {
        try {
          const page = await this.browserFetchProvider(url);
          if (signal?.aborted) return null;
          metrics.toolCalls += 1;
          return { url, title: page.title || title, content: page.content, score: 0 };
        } catch {
          // Return the original (short) content.
        }
      }

      return { url, title, content, score: 0 };
    } catch {
      // If simple fetch fails and we have a browser provider, try that.
      if (this.browserFetchProvider != null) {
        try {
          const page = await this.browserFetchProvider(url);
          if (signal?.aborted) return null;
          metrics.toolCalls += 1;
          return { url, title: page.title || title, content: page.content, score: 0 };
        } catch {
          return null;
        }
      }
      return null;
    }
  }

  /** Determine whether a URL likely requires JavaScript rendering. */
  private needsBrowserForUrl(url: string): boolean {
    const lower = url.toLowerCase();
    return JS_REQUIRED_PATTERNS.some((pattern) => lower.includes(pattern));
  }

  private async synthesizeReport(
    task: string,
    queries: string[],
    pages: FetchedPage[],
    metrics: AgentMetrics,
    signal?: AbortSignal,
  ): Promise<ResearchReport> {
    if (pages.length === 0) {
      return {
        markdown: 'No sources could be fetched for this research task.',
        sources: [],
        queries,
        satisfied: false,
      };
    }

    // Re-score full content and sort.
    const scoredPages = pages.map((p) => ({ ...p, score: this.scoreSource(p.url, p.content, task) }));
    scoredPages.sort((a, b) => b.score - a.score);

    // Build sources list; the LLM prompt maps [index] to these sources.
    const sourcesText = scoredPages
      .map((p, i) => `[${i + 1}] ${p.title}\nURL: ${p.url}\n${p.content.slice(0, 3500)}`)
      .join('\n\n---\n\n');

    const messages: LLMMessage[] = [
      {
        role: 'system',
        content:
          'You are a research synthesizer. Read the collected sources and produce a well-structured Markdown report. Every factual claim must be supported by an inline citation like [1], [2], etc. Include an executive summary, key findings, and a Sources section. Return a JSON object: {"markdown": "...", "satisfied": true|false, "sources": [{"index": 1, "title": "...", "url": "..."}]}.',
      },
      {
        role: 'user',
        content: `Task: ${task}\n\nQueries used: ${queries.join('; ')}\n\nCollected sources:\n\n${sourcesText}`,
      },
    ];

    const res = await this.llm.generate({
      model: this.model,
      messages,
      jsonMode: true,
      maxTokens: this.maxReportTokens,
      signal,
    });
    metrics.llmCalls += 1;
    metrics.tokensIn += res.usage.tokensIn;
    metrics.tokensOut += res.usage.tokensOut;
    metrics.costUsd += res.costUsd ?? 0;

    try {
      const parsed = JSON.parse(res.message.content ?? '{}');
      const markdown = typeof parsed.markdown === 'string' ? parsed.markdown : '(no report generated)';
      const satisfied = parsed.satisfied === true;
      const sources = Array.isArray(parsed.sources)
        ? parsed.sources
            .filter((s: unknown) => s && typeof (s as any).url === 'string')
            .map((s: any, idx: number) => ({
              index: typeof s.index === 'number' ? s.index : idx + 1,
              title: String(s.title ?? 'Source'),
              url: String(s.url),
            }))
        : scoredPages.map((p, i) => ({ index: i + 1, title: p.title, url: p.url }));

      return { markdown, sources, queries, satisfied };
    } catch {
      // Fallback: plain markdown with auto-generated sources.
      const fallbackSources = scoredPages.map((p, i) => ({ index: i + 1, title: p.title, url: p.url }));
      return {
        markdown: res.message.content ?? '(no report generated)',
        sources: fallbackSources,
        queries,
        satisfied: false,
      };
    }
  }

  private async generateMindMap(
    task: string,
    report: ResearchReport,
    metrics: AgentMetrics,
    signal?: AbortSignal,
  ): Promise<{ mindMap?: string; mindMapText?: string }> {
    const messages: LLMMessage[] = [
      {
        role: 'system',
        content:
          'You are a mind-map generator. Given a research task and its report, produce a Mermaid mindmap diagram. Use syntax:\n' +
          'mindmap\n  root((Topic))\n    Branch A\n      Sub-branch A1\n      Sub-branch A2\n    Branch B\n' +
          'Keep it concise (max 6 branches, 3 levels deep). Output only the Mermaid code block.',
      },
      {
        role: 'user',
        content: `Task: ${task}\n\nReport:\n${report.markdown.slice(0, 3000)}`,
      },
    ];

    const res = await this.llm.generate({
      model: this.model,
      messages,
      maxTokens: 1024,
      signal,
    });
    metrics.llmCalls += 1;
    metrics.tokensIn += res.usage.tokensIn;
    metrics.tokensOut += res.usage.tokensOut;
    metrics.costUsd += res.costUsd ?? 0;

    const mindMap = res.message.content?.trim() ?? '';
    const mindMapText = this.mermaidToText(mindMap);
    return { mindMap, mindMapText };
  }

  /** Convert a simple Mermaid mindmap to a plain-text tree for quick preview. */
  private mermaidToText(mermaid: string): string | undefined {
    const lines = mermaid
      .replace(/^```mermaid\s*/i, '')
      .replace(/```\s*$/i, '')
      .split('\n')
      .map((l) => l.replace(/\t/g, '  '))
      .filter((l) => l.trim().length > 0);

    if (lines.length === 0 || !lines[0].toLowerCase().includes('mindmap')) {
      return undefined;
    }

    const out: string[] = [];
    for (let i = 1; i < lines.length; i++) {
      const raw = lines[i];
      const indent = raw.search(/\S/);
      const label = raw.trim().replace(/\(\(|\)\)/g, '').replace(/^\(?(.*?)\)?$/, '$1');
      const depth = Math.max(0, Math.floor(indent / 2) - 1);
      const prefix = depth === 0 ? '' : '│  '.repeat(depth - 1) + (i === lines.length - 1 || lines[i + 1]?.search(/\S/) <= indent ? '└─ ' : '├─ ');
      out.push(prefix + label);
    }
    return out.length > 0 ? out.join('\n') : undefined;
  }
}

class SearchCache {
  private readonly dir: string;
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly maxBytes: number;

  constructor(
    dir: string,
    ttlMs = 24 * 60 * 60 * 1000,
    maxEntries = 100,
    maxBytes = 50 * 1024 * 1024,
  ) {
    this.dir = dir;
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
  }

  async get(query: string): Promise<SearchResult[] | undefined> {
    const file = path.join(this.dir, `${this.key(query)}.json`);
    try {
      const raw = fs.readFileSync(file, 'utf-8');
      const entry = JSON.parse(raw) as SearchCacheEntry;
      if (Date.now() - entry.fetchedAt > this.ttlMs) {
        fs.unlinkSync(file);
        return undefined;
      }
      // Update last-accessed for LRU ordering.
      entry.lastAccessed = Date.now();
      fs.writeFileSync(file, JSON.stringify(entry, null, 2), 'utf-8');
      return entry.results;
    } catch {
      return undefined;
    }
  }

  async set(query: string, results: SearchResult[]): Promise<void> {
    const file = path.join(this.dir, `${this.key(query)}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const now = Date.now();
    const entry: SearchCacheEntry = {
      query,
      fetchedAt: now,
      lastAccessed: now,
      results,
      ttlMs: this.ttlMs,
    };
    fs.writeFileSync(file, JSON.stringify(entry, null, 2), 'utf-8');
    await this.enforceLimits();
  }

  private async enforceLimits(): Promise<void> {
    try {
      const files = fs.readdirSync(this.dir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => {
          const p = path.join(this.dir, f);
          try {
            const stat = fs.statSync(p);
            const raw = fs.readFileSync(p, 'utf-8');
            const entry = JSON.parse(raw) as SearchCacheEntry;
            return {
              path: p,
              size: stat.size,
              lastAccessed: entry.lastAccessed ?? entry.fetchedAt,
            };
          } catch {
            return null;
          }
        })
        .filter((x): x is NonNullable<typeof x> => x !== null);

      // Sort oldest-first by lastAccessed.
      files.sort((a, b) => a.lastAccessed - b.lastAccessed);

      let totalBytes = files.reduce((sum, f) => sum + f.size, 0);

      // Enforce max entries.
      while (files.length > this.maxEntries) {
        const oldest = files.shift();
        if (!oldest) break;
        try { fs.unlinkSync(oldest.path); totalBytes -= oldest.size; } catch { /* ignore */ }
      }

      // Enforce max bytes by dropping oldest LRU entries.
      while (totalBytes > this.maxBytes && files.length > 0) {
        const oldest = files.shift();
        if (!oldest) break;
        try { fs.unlinkSync(oldest.path); totalBytes -= oldest.size; } catch { /* ignore */ }
      }
    } catch {
      // ignore cleanup errors
    }
  }

  private key(query: string): string {
    return crypto.createHash('sha256').update(query).digest('hex').slice(0, 16);
  }
}
